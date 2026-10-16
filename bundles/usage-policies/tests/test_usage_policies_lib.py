import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import usage_policies_lib as lib

WS = 111
REQ = ["cost_center", "project", "owner"]
TAGS = {"cost_center": "cc-1", "project": "p", "owner": "team-a"}


def pol(name="zz-a", tags=None, **kw):
    return lib.Policy(name=name, tags=dict(TAGS if tags is None else tags), **kw)


# --- validation -------------------------------------------------------------

def test_valid_policies_have_no_errors():
    assert lib.validate([pol(), pol("zz-b", users=["groups/g"], managers=["users/a@x.com"])], REQ) == []


def test_validate_lists_every_error():
    bad = [
        pol(""),
        pol("x" * 128),
        pol("dup"),
        pol("dup"),
        pol("reserved", tags={**TAGS, "budget-policy-id": "1"}),
        pol("marker", tags={**TAGS, lib.MARKER_KEY: "me"}),
        pol("missing", tags={"project": "p"}),
        pol("longval", tags={**TAGS, "k": "v" * 257}),
        pol("toomany", tags={**TAGS, **{f"t{i}": "v" for i in range(17)}}),
        pol("casedup", tags={**TAGS, "Project": "q"}),
        pol("badprin", users=["alice@x.com"], managers=["groups/"]),
        pol("badws", workspace_ids=["nope"]),
    ]
    errs = lib.validate(bad, REQ)
    text = "\n".join(errs)
    assert "name must be 1-127 characters" in text
    assert "duplicate policy name 'dup'" in text
    assert "'budget-policy-id' is reserved" in text
    assert f"'{lib.MARKER_KEY}' is added automatically" in text
    assert "[missing] missing required tag 'cost_center'" in text and "[missing] missing required tag 'owner'" in text
    assert "[longval] tag 'k' value exceeds 256 characters" in text
    assert "[toomany] 21 tags including the managed marker (max 20)" in text
    assert "[casedup] duplicate tag key 'project'" in text
    assert "[badprin] invalid principal 'alice@x.com'" in text and "invalid principal 'groups/'" in text
    assert "[badws] workspace_ids" in text
    assert len(errs) >= 13


def test_twenty_tags_including_marker_is_allowed():
    tags = {**TAGS, **{f"t{i}": "v" for i in range(16)}}
    assert len(tags) == 19
    assert lib.validate([pol(tags=tags)], REQ) == []


def test_normalize_accepts_dicts_and_resolves_workspace_ids():
    a, b, c = lib.normalize([
        {"name": "a", "tags": TAGS},
        {"name": "b", "tags": TAGS, "workspace_ids": "all", "users": ["groups/g"]},
        pol("c", workspace_ids=[3, 2]),
    ], WS)
    assert a.workspace_ids == [WS] and a.users == [] and a.managers == []
    assert b.workspace_ids == [] and b.users == ["groups/g"]
    assert c.workspace_ids == [2, 3]


# --- client wire format -----------------------------------------------------

ACCT = "acct-1"
ME = "users/me@x.com"


def ws_client(do):
    w = mock.MagicMock()
    w.api_client.do.side_effect = do
    return w


def client(do, sleep=None):
    return lib.Client(ws_client(do), ACCT, sleep=sleep or (lambda s: None))


def test_create_sends_nested_body_with_request_id_and_marker():
    calls = []

    def do(method, path, query=None, body=None, **kw):
        calls.append((method, path, body))
        return {**body["policy"], "policy_id": "p1"}

    out = client(do).create_policy(lib.desired_body(pol(workspace_ids=[WS])), "rid-1")
    assert out["policy_id"] == "p1"
    method, path, body = calls[0]
    assert (method, path) == ("POST", lib.BASE)
    assert body["request_id"] == "rid-1"
    assert body["policy"]["policy_name"] == "zz-a"
    assert body["policy"]["binding_workspace_ids"] == [WS]
    assert {"key": lib.MARKER_KEY, "value": lib.MARKER_VALUE} in body["policy"]["custom_tags"]
    assert {"key": "project", "value": "p"} in body["policy"]["custom_tags"]


def test_patch_sends_full_flat_body_with_policy_name():
    calls = []

    def do(method, path, query=None, body=None, **kw):
        calls.append((method, path, body))
        return {**body, "policy_id": "p1"}

    desired = lib.desired_body(pol(workspace_ids=[]))
    client(do).update_policy("p1", desired)
    method, path, body = calls[0]
    assert (method, path) == ("PATCH", f"{lib.BASE}/p1")
    assert set(body) == {"policy_name", "custom_tags", "binding_workspace_ids"}
    assert body["policy_name"] == "zz-a" and body["binding_workspace_ids"] == []
    assert "policy" not in body and "update_mask" not in body


def test_list_paginates_and_handles_empty_response():
    pages = {None: {"policies": [{"policy_id": "1"}], "next_page_token": "t2"},
             "t2": {"policies": [{"policy_id": "2"}], "next_page_token": ""}}
    seen = []

    def do(method, path, query=None, **kw):
        seen.append(query)
        return pages[query.get("page_token")]

    assert [p["policy_id"] for p in client(do).list_policies()] == ["1", "2"]
    assert seen[0]["page_size"] and "page_token" not in seen[0] and seen[1]["page_token"] == "t2"
    assert client(lambda *a, **k: {}).list_policies() == []


def test_rule_set_get_and_put_use_account_scoped_name_and_etag():
    calls = []
    name = f"accounts/{ACCT}/budgetPolicies/p1/ruleSets/default"

    def do(method, path, query=None, body=None, **kw):
        calls.append((method, path, query, body))
        return {"name": name, "etag": "e1", "grant_rules": [{"role": lib.MANAGER_ROLE, "principals": [ME]}]}

    c = client(do)
    rs = c.get_rule_set("p1")
    assert rs["etag"] == "e1"
    c.put_rule_set("p1", "e1", rs["grant_rules"])
    assert calls[0][:3] == ("GET", lib.RULE_SETS, {"name": name, "etag": ""})
    assert calls[1][1] == lib.RULE_SETS
    assert calls[1][3] == {"name": name, "rule_set": {"name": name, "etag": "e1", "grant_rules": rs["grant_rules"]}}


def test_discover_account_id_prefers_override_then_workspace_well_known():
    w = ws_client(lambda m, p, **k: {"account_id": "from-host"} if p == "/.well-known/databricks-config" else None)
    assert lib.discover_account_id(w, "  override ") == "override"
    assert lib.discover_account_id(w, "") == "from-host"
    with pytest.raises(RuntimeError, match="account_id widget"):
        lib.discover_account_id(ws_client(lambda *a, **k: {}), None)


def test_caller_principal_for_user_and_service_principal():
    assert lib.caller_principal(ws_client(lambda *a, **k: {"userName": "me@x.com"})) == ME
    assert lib.caller_principal(ws_client(lambda *a, **k: {"userName": "1234-abcd"})) == "servicePrincipals/1234-abcd"


# --- plan -------------------------------------------------------------------

from databricks.sdk.errors import NotFound, PermissionDenied

MARK = {lib.MARKER_KEY: lib.MARKER_VALUE}


class FakeApi:
    """Stateful stand-in for `w.api_client.do` covering policies and rule sets."""

    def __init__(self, stale_reads=0, list_lag=0):
        self.policies, self.rules, self.calls, self.denied = {}, {}, [], set()
        self.stale_reads, self._stale, self._n = stale_reads, {}, 0
        self.list_lag, self._list_snapshot = list_lag, None

    def add(self, name, tags, ws=(WS,), rules=None):
        self._n += 1
        pid = f"id{self._n}"
        self.policies[pid] = {"policy_id": pid, "policy_name": name, "binding_workspace_ids": list(ws),
                              "custom_tags": [{"key": k, "value": v} for k, v in tags.items()]}
        self.rules[pid] = {"etag": "e0", "grant_rules": rules if rules is not None else
                           [{"role": lib.MANAGER_ROLE, "principals": [ME]}]}
        return pid

    def _write(self, pid, new):
        self._stale[pid] = (self.policies.get(pid), self.stale_reads)
        if self.list_lag and self._list_snapshot is None:
            self._list_snapshot = (dict(self.policies), self.list_lag)
        if new is None:
            self.policies.pop(pid, None)
        else:
            self.policies[pid] = new

    def __call__(self, method, path, query=None, body=None, **kw):
        self.calls.append((method, path, query, body))
        if path == lib.RULE_SETS:
            name = query["name"] if method == "GET" else body["name"]
            pid = name.split("/")[3]
            if pid in self.denied:
                raise PermissionDenied("denied")
            if method == "GET":
                return {"name": name, **self.rules[pid]}
            self.rules[pid] = {"etag": "e1", "grant_rules": body["rule_set"]["grant_rules"]}
            return body["rule_set"]
        if path == lib.BASE and method == "GET":
            pols = self.policies
            if self._list_snapshot:
                pols, left = self._list_snapshot
                self._list_snapshot = (pols, left - 1) if left > 1 else None
            return {"policies": list(pols.values())} if pols else {}
        if path == lib.BASE and method == "POST":
            self._n += 1
            pid = f"id{self._n}"
            self._write(pid, {**body["policy"], "policy_id": pid})
            self.rules[pid] = {"etag": "e0", "grant_rules": [{"role": lib.MANAGER_ROLE, "principals": [ME]}]}
            return self.policies[pid]
        pid = path.rsplit("/", 1)[1]
        if pid in self.denied:
            raise PermissionDenied("denied")
        old, left = self._stale.get(pid, (None, 0))
        if method == "GET":
            if left:
                self._stale[pid] = (old, left - 1)
                if old is None:
                    raise NotFound("not yet")
                return old
            if pid not in self.policies:
                raise NotFound("gone")
            return self.policies[pid]
        if method == "PATCH":
            self._write(pid, {**body, "policy_id": pid})
            return self.policies[pid]
        if method == "DELETE":
            self._write(pid, None)
            return {}
        raise AssertionError((method, path))


def plan(api, declared, allow_deletes=False):
    c = lib.Client(ws_client(api), ACCT, sleep=lambda s: None)
    return c, lib.build_plan(c, lib.normalize(declared, WS), ME, allow_deletes)


def actions(steps):
    return [(s.name, s.action) for s in steps]


def test_plan_create_for_new_policy_with_grants():
    _, steps = plan(FakeApi(), [pol(users=["groups/g"])])
    assert actions(steps) == [("zz-a", "create"), ("zz-a", "grants")]
    assert "+ users: groups/g" in "\n".join(steps[1].details)


def test_plan_no_op_when_live_matches():
    api = FakeApi()
    api.add("zz-a", {**TAGS, **MARK})
    _, steps = plan(api, [pol()])
    assert actions(steps) == [("zz-a", "no-op")]


def test_plan_update_shows_field_level_diff():
    api = FakeApi()
    api.add("zz-a", {**TAGS, "project": "old", "extra": "x", **MARK}, ws=(WS, 222))
    _, steps = plan(api, [pol(tags={**TAGS, "new": "n"})])
    assert actions(steps) == [("zz-a", "update")]
    d = "\n".join(steps[0].details)
    assert "~ tag project: 'old' -> 'p'" in d
    assert "+ tag new='n'" in d and "- tag extra='x'" in d
    assert f"~ workspaces: [{WS}, 222] -> [{WS}]" in d


def test_plan_adopt_for_unmarked_policy_with_same_name():
    api = FakeApi()
    api.add("zz-a", TAGS)
    _, steps = plan(api, [pol()])
    assert actions(steps) == [("zz-a", "adopt")]
    assert f"+ tag {lib.MARKER_KEY}='{lib.MARKER_VALUE}'" in steps[0].details


def test_plan_grants_adds_and_removes_and_preserves_other_roles():
    api = FakeApi()
    other = {"role": "roles/some.other", "principals": ["groups/keep"]}
    api.add("zz-a", {**TAGS, **MARK}, rules=[
        {"role": lib.USER_ROLE, "principals": ["groups/old"]},
        {"role": lib.MANAGER_ROLE, "principals": [ME, "users/b@x.com"]}, other])
    _, steps = plan(api, [pol(users=["groups/new"], managers=["groups/mgr"])])
    assert actions(steps) == [("zz-a", "grants")]
    d = "\n".join(steps[0].details)
    assert "+ users: groups/new" in d and "- users: groups/old" in d
    assert "+ managers: groups/mgr" in d and "- managers: users/b@x.com" in d
    rules = {r["role"]: sorted(r["principals"]) for r in steps[0].grant_rules}
    assert rules[lib.USER_ROLE] == ["groups/new"]
    assert rules["roles/some.other"] == ["groups/keep"]


def test_caller_manager_grant_is_never_removed():
    api = FakeApi()
    api.add("zz-a", {**TAGS, **MARK}, rules=[{"role": lib.MANAGER_ROLE, "principals": [ME, "users/b@x.com"]}])
    _, steps = plan(api, [pol(managers=[])])
    rules = {r["role"]: r["principals"] for r in steps[0].grant_rules}
    assert rules[lib.MANAGER_ROLE] == [ME]
    d = "\n".join(steps[0].details)
    assert f"- managers: {ME}" not in d and "direct Manager grant" in d


def test_delete_planned_only_for_marked_policies_and_flagged_without_allow_deletes():
    api = FakeApi()
    api.add("zz-marked", {**TAGS, **MARK})
    api.add("someone-elses", TAGS)
    _, steps = plan(api, [])
    assert actions(steps) == [("zz-marked", "delete")]
    assert "skipped unless allow_deletes=true" in "\n".join(steps[0].details)
    _, steps = plan(api, [], allow_deletes=True)
    assert actions(steps) == [("zz-marked", "delete")] and not steps[0].details


def test_plan_403_on_one_policy_is_isolated():
    api = FakeApi()
    bad = api.add("zz-bad", {**TAGS, **MARK})
    api.add("zz-ok", {**TAGS, "project": "old", **MARK})
    api.denied.add(bad)
    _, steps = plan(api, [pol("zz-bad"), pol("zz-ok")])
    assert actions(steps) == [("zz-bad", "error"), ("zz-ok", "update")]
    assert "denied" in steps[0].error


def test_plan_rows_are_display_ready():
    _, steps = plan(FakeApi(), [pol()])
    rows = lib.plan_rows(steps)
    assert rows[0]["policy"] == "zz-a" and rows[0]["action"] == "create" and isinstance(rows[0]["details"], str)


# --- apply ------------------------------------------------------------------

def run_apply(api, declared, allow_deletes=False, token="run-1"):
    c, steps = plan(api, declared, allow_deletes)
    return steps, lib.apply_plan(c, steps, token, ME, allow_deletes)


def by_action(results):
    return {(r["policy"], r["action"]): r["status"] for r in results}


def test_apply_create_then_grants_on_new_policy():
    api = FakeApi()
    _, res = run_apply(api, [pol(users=["groups/g"])])
    assert by_action(res) == {("zz-a", "create"): "ok", ("zz-a", "grants"): "ok"}
    (pid,) = api.policies
    assert lib.is_managed(api.policies[pid])
    rules = {r["role"]: r["principals"] for r in api.rules[pid]["grant_rules"]}
    assert rules == {lib.USER_ROLE: ["groups/g"], lib.MANAGER_ROLE: [ME]}


def test_create_request_id_is_deterministic_per_run_and_policy():
    assert lib.request_id("run-1", "zz-a") == lib.request_id("run-1", "zz-a")
    assert lib.request_id("run-1", "zz-a") != lib.request_id("run-2", "zz-a")
    assert lib.request_id("run-1", "zz-a") != lib.request_id("run-1", "zz-b")
    api = FakeApi()
    run_apply(api, [pol()], token="run-1")
    posts = [b for m, p, q, b in api.calls if m == "POST"]
    assert posts[0]["request_id"] == lib.request_id("run-1", "zz-a")


def test_apply_update_patches_and_adopt_adds_marker():
    api = FakeApi()
    upd = api.add("zz-a", {**TAGS, "project": "old", **MARK})
    adp = api.add("zz-b", TAGS)
    _, res = run_apply(api, [pol(), pol("zz-b")])
    assert by_action(res) == {("zz-a", "update"): "ok", ("zz-b", "adopt"): "ok"}
    assert lib.tags_of(api.policies[upd])["project"] == "p"
    assert lib.is_managed(api.policies[adp])


def test_delete_executes_only_with_allow_deletes():
    api = FakeApi()
    pid = api.add("zz-gone", {**TAGS, **MARK})
    _, res = run_apply(api, [], allow_deletes=False)
    assert by_action(res) == {("zz-gone", "delete"): "skipped"}
    assert pid in api.policies and not [c for c in api.calls if c[0] == "DELETE"]
    _, res = run_apply(api, [], allow_deletes=True)
    assert by_action(res) == {("zz-gone", "delete"): "ok"}
    assert pid not in api.policies


def test_unmarked_undeclared_policy_is_never_touched():
    api = FakeApi()
    api.add("not-ours", TAGS)
    run_apply(api, [], allow_deletes=True)
    assert [c[0] for c in api.calls if c[0] not in ("GET",)] == []


def test_apply_403_on_one_policy_reports_and_continues():
    api = FakeApi()
    bad = api.add("zz-bad", {**TAGS, "project": "old", **MARK})
    good = api.add("zz-ok", {**TAGS, "project": "old", **MARK})
    c, steps = plan(api, [pol("zz-bad"), pol("zz-ok")])
    api.denied.add(bad)
    res = lib.apply_plan(c, steps, "run-1", ME, False)
    assert by_action(res) == {("zz-bad", "update"): "failed", ("zz-ok", "update"): "ok"}
    assert "denied" in [r for r in res if r["policy"] == "zz-bad"][0]["message"]
    assert lib.tags_of(api.policies[good])["project"] == "p"


def test_failed_create_skips_its_grants_step():
    def do(method, path, query=None, body=None, **kw):
        if method == "POST":
            raise PermissionDenied("nope")
        return {}
    c = lib.Client(ws_client(do), ACCT, sleep=lambda s: None)
    steps = lib.build_plan(c, lib.normalize([pol(users=["groups/g"])], WS), ME)
    res = lib.apply_plan(c, steps, "t", ME, False)
    assert [r["status"] for r in res] == ["failed", "skipped"]


def test_verify_retries_stale_read_after_write_with_backoff():
    api = FakeApi(stale_reads=2)
    pid = api.add("zz-a", {**TAGS, "project": "old", **MARK})
    sleeps = []
    c = lib.Client(ws_client(api), ACCT, sleep=sleeps.append)
    steps = lib.build_plan(c, lib.normalize([pol()], WS), ME)
    res = lib.apply_plan(c, steps, "t", ME, False)
    assert by_action(res) == {("zz-a", "update"): "ok"}
    gets = [p for m, p, q, b in api.calls if m == "GET" and p == f"{lib.BASE}/{pid}"]
    # ownership re-check, then two stale reads, then SETTLE_READS fresh ones in a row
    assert len(gets) == lib.SETTLE_READS + 2 + lib.SETTLE_READS
    assert sleeps[lib.SETTLE_READS - 1:][:2] == [1.0, 2.0]


def test_retry_requires_consecutive_fresh_reads_because_replicas_flip():
    seq = iter([True, False, True, True, True])
    c = lib.Client(ws_client(lambda *a, **k: {}), ACCT, sleep=lambda s: None)
    ok, _ = lib.retry(c, lambda: next(seq), bool, settle=3)
    assert ok
    import itertools
    seq, calls = itertools.cycle([True, False]), []
    ok, _ = lib.retry(c, lambda: calls.append(1) or next(seq), bool, attempts=6, settle=3)
    assert not ok and len(calls) == 12  # bounded: gives up after 6 stale reads


def test_verify_reports_unconfirmed_when_reads_stay_stale():
    api = FakeApi(stale_reads=100)
    api.add("zz-a", {**TAGS, "project": "old", **MARK})
    c = lib.Client(ws_client(api), ACCT, sleep=lambda s: None)
    res = lib.apply_plan(c, lib.build_plan(c, lib.normalize([pol()], WS), ME), "t", ME, False)
    assert res[0]["status"] == "unconfirmed"


def test_verify_waits_for_delete_to_be_visible():
    api = FakeApi(stale_reads=1)
    api.add("zz-gone", {**TAGS, **MARK})
    _, res = run_apply(api, [], allow_deletes=True)
    assert by_action(res) == {("zz-gone", "delete"): "ok"}


def test_list_retries_not_found_from_stale_index_after_delete():
    n = {"calls": 0}

    def do(method, path, query=None, **kw):
        n["calls"] += 1
        if n["calls"] == 1:
            raise NotFound("BudgetPolicy x not found")
        return {"policies": [{"policy_id": "1"}]}

    sleeps = []
    assert [p["policy_id"] for p in client(do, sleep=sleeps.append).list_policies()] == ["1"]
    assert sleeps == [1.0]


def test_apply_waits_until_list_reflects_changes_so_next_plan_is_accurate():
    api = FakeApi(list_lag=2)
    upd = api.add("zz-u", {**TAGS, "project": "old", **MARK})
    gone = api.add("zz-gone", {**TAGS, **MARK})
    sleeps = []
    c = lib.Client(ws_client(api), ACCT, sleep=sleeps.append)
    steps = lib.build_plan(c, lib.normalize([pol("zz-new"), pol("zz-u")], WS), ME, True)
    res = lib.apply_plan(c, steps, "t", ME, True)
    assert {r["status"] for r in res} == {"ok"}, res
    assert sleeps  # waited for the list to catch up
    assert actions(lib.build_plan(c, lib.normalize([pol("zz-new"), pol("zz-u")], WS), ME, True)) == [
        ("zz-new", "no-op"), ("zz-u", "no-op")]


def test_apply_marks_unconfirmed_when_list_stays_stale():
    api = FakeApi(list_lag=100)
    c = lib.Client(ws_client(api), ACCT, sleep=lambda s: None)
    res = lib.apply_plan(c, lib.build_plan(c, lib.normalize([pol()], WS), ME), "t", ME, False)
    assert res[0]["status"] == "unconfirmed" and "list" in res[0]["message"]


def test_create_conflict_explains_stale_list():
    from databricks.sdk.errors import ResourceAlreadyExists

    def do(method, path, query=None, body=None, **kw):
        if method == "POST":
            raise ResourceAlreadyExists("exists")
        return {}
    c = lib.Client(ws_client(do), ACCT, sleep=lambda s: None)
    res = lib.apply_plan(c, lib.build_plan(c, lib.normalize([pol()], WS), ME), "t", ME, False)
    assert res[0]["status"] == "failed" and "re-run the plan" in res[0]["message"]


# --- import + chargeback ------------------------------------------------------

def test_export_policies_is_a_pasteable_literal():
    api = FakeApi()
    api.add("zz-a", {**TAGS, **MARK}, rules=[{"role": lib.USER_ROLE, "principals": ["groups/g"]},
                                            {"role": lib.MANAGER_ROLE, "principals": [ME]}])
    api.add("zz-all", TAGS, ws=())
    hidden = api.add("zz-hidden", TAGS, ws=(5, 6))
    api.denied.add(hidden)
    c = lib.Client(ws_client(api), ACCT)
    src = lib.export_policies(c, WS)
    ns = {}
    exec(src, ns)
    got = {p["name"]: p for p in ns["POLICIES"]}
    assert got["zz-a"] == {"name": "zz-a", "tags": TAGS, "users": ["groups/g"], "managers": [ME]}
    assert got["zz-all"]["workspace_ids"] == "all"
    assert got["zz-hidden"]["workspace_ids"] == [5, 6] and "users" not in got["zz-hidden"]
    assert "# zz-hidden: grants not readable" in src


def test_chargeback_dates_default_and_validate():
    import datetime as dt
    assert lib.chargeback_dates("", "", today=dt.date(2026, 3, 31)) == ("2026-03-01", "2026-03-31")
    assert lib.chargeback_dates("2026-01-01", "2026-01-31") == ("2026-01-01", "2026-01-31")
    with pytest.raises(ValueError):
        lib.chargeback_dates("2026-02-01", "2026-01-01")
    with pytest.raises(ValueError):
        lib.chargeback_dates("01/01/2026", "")
    sql = lib.chargeback_sql("day")
    assert ":start_date" in sql and ":end_date" in sql and "system.billing.list_prices" in sql
    assert "usage_policy_id" in sql and "budget_policy_id" in sql


# --- review fixes: apply-time ownership, lockout, chargeback units, shape errors

def unmark(api, pid):
    api.policies[pid]["custom_tags"] = [t for t in api.policies[pid]["custom_tags"] if t["key"] != lib.MARKER_KEY]


def mutations(api):
    return [c[0] for c in api.calls if c[0] in ("POST", "PATCH", "DELETE", "PUT")]


def test_delete_refused_when_marker_removed_between_plan_and_apply():
    api = FakeApi()
    pid = api.add("zz-gone", {**TAGS, **MARK})
    c, steps = plan(api, [], allow_deletes=True)
    assert actions(steps) == [("zz-gone", "delete")]
    unmark(api, pid)
    res = lib.apply_plan(c, steps, "t", ME, True)
    assert by_action(res) == {("zz-gone", "delete"): "skipped"}
    assert "target changed since plan" in res[0]["message"]
    assert mutations(api) == [] and pid in api.policies


def test_delete_refused_when_policy_renamed_or_gone_after_plan():
    api = FakeApi()
    renamed = api.add("zz-r", {**TAGS, **MARK})
    gone = api.add("zz-g", {**TAGS, **MARK})
    c, steps = plan(api, [], allow_deletes=True)
    api.policies[renamed]["policy_name"] = "someone-else"
    del api.policies[gone]
    res = lib.apply_plan(c, steps, "t", ME, True)
    assert {r["status"] for r in res} == {"skipped"}
    assert all("target changed since plan" in r["message"] for r in res)
    assert mutations(api) == []


def test_update_and_grants_refused_when_marker_removed_after_plan():
    api = FakeApi()
    pid = api.add("zz-a", {**TAGS, "project": "old", **MARK})
    c, steps = plan(api, [pol(users=["groups/g"])])
    assert actions(steps) == [("zz-a", "update"), ("zz-a", "grants")]
    unmark(api, pid)
    res = lib.apply_plan(c, steps, "t", ME, False)
    assert [r["status"] for r in res] == ["skipped", "skipped"]
    assert mutations(api) == []


def test_ownership_check_needs_consecutive_confirming_reads():
    # One stale read still showing the marker must not be enough to delete.
    api = FakeApi()
    pid = api.add("zz-gone", {**TAGS, **MARK})
    c, steps = plan(api, [], allow_deletes=True)
    marked = dict(api.policies[pid])
    unmark(api, pid)
    real = api.__call__
    served = {"n": 0}

    def flaky(method, path, query=None, body=None, **kw):
        if method == "GET" and path == f"{lib.BASE}/{pid}" and served["n"] == 0:
            served["n"] += 1
            return marked
        return real(method, path, query, body, **kw)

    c = lib.Client(ws_client(flaky), ACCT, sleep=lambda s: None)
    res = lib.apply_plan(c, steps, "t", ME, True)
    assert res[0]["status"] == "skipped" and mutations(api) == []


def test_adopt_then_grants_in_same_apply_passes_ownership_check():
    api = FakeApi()
    pid = api.add("zz-b", TAGS)
    c, steps = plan(api, [pol("zz-b", users=["groups/g"])])
    assert actions(steps) == [("zz-b", "adopt"), ("zz-b", "grants")]
    res = lib.apply_plan(c, steps, "t", ME, False)
    assert by_action(res) == {("zz-b", "adopt"): "ok", ("zz-b", "grants"): "ok"}
    assert lib._principals(api.rules[pid]["grant_rules"], lib.USER_ROLE) == {"groups/g"}


def test_group_only_manager_caller_gets_a_direct_manager_grant():
    rules, details = lib.compute_grants([{"role": lib.MANAGER_ROLE, "principals": ["groups/admins"]}], [], [], ME)
    assert {r["role"]: r["principals"] for r in rules} == {lib.MANAGER_ROLE: [ME]}
    d = "\n".join(details)
    assert f"+ managers: {ME}" in d and "- managers: groups/admins" in d
    assert "direct Manager grant" in d


def test_plan_for_group_only_manager_caller_keeps_direct_access():
    api = FakeApi()
    pid = api.add("zz-a", {**TAGS, **MARK}, rules=[{"role": lib.MANAGER_ROLE, "principals": ["groups/admins"]}])
    c, steps = plan(api, [pol(managers=[])])
    lib.apply_plan(c, steps, "t", ME, False)
    assert lib._principals(api.rules[pid]["grant_rules"], lib.MANAGER_ROLE) == {ME}


def test_chargeback_sql_filters_one_currency_and_groups_by_usage_unit():
    for dim in ("policy", "tag", "day"):
        sql = lib.chargeback_sql(dim)
        assert "p.currency_code = :currency_code" in sql
        assert "AND u.usage_end_time >= p.price_start_time" in sql
        group_by = sql.split("GROUP BY", 1)[1]
        assert "usage_unit" in group_by and "currency_code" in group_by
        assert "usage_unit" in sql.split("FROM", 1)[0] and "dbus" not in sql
    assert ":tag_key" in lib.chargeback_sql("tag")
    assert "policy_id" in lib.chargeback_sql("policy").split("GROUP BY", 1)[1]
    assert "usage_date" in lib.chargeback_sql("day").split("GROUP BY", 1)[1]
    with pytest.raises(ValueError):
        lib.chargeback_sql("nope")


def test_currency_code_is_validated():
    assert lib.currency_code("") == "USD" and lib.currency_code(" eur ") == "EUR"
    with pytest.raises(ValueError):
        lib.currency_code("US Dollar")


def test_prepare_lists_shape_errors_with_other_validation_errors():
    pols, errs = lib.prepare([
        {"name": "ok", "tags": TAGS},
        {"name": "badtags", "tags": ["cost_center"]},
        {"name": "typo", "tags": TAGS, "manager": ["groups/g"]},
        {"tags": TAGS},
        {"name": "strusers", "tags": TAGS, "users": "groups/g"},
        "not-a-dict",
        {"name": "missing", "tags": {"project": "p"}},
    ], WS, REQ)
    text = "\n".join(errs)
    assert "[badtags] tags must be a mapping" in text
    assert "[typo] unknown field(s): manager" in text
    assert "policy #4: missing field(s): name" in text
    assert "[strusers] users must be a list" in text
    assert "policy #6: must be a dict" in text
    assert "[missing] missing required tag 'cost_center'" in text
    assert [p.name for p in pols] == ["ok", "missing"]
    assert lib.prepare("nope", WS, REQ)[1] == ["POLICIES must be a list"]


def _after_adopt_verified(api, pid, on_get):
    """Wrap the fake: once the adopt PATCH has been verified (SETTLE_READS GETs), call on_get(n, resp)
    for every later GET of the policy, n = 1, 2, ..."""
    state = {"patched": False, "gets": 0}

    def do(method, path, query=None, body=None, **kw):
        resp = api(method, path, query, body, **kw)
        if method == "PATCH" and path == f"{lib.BASE}/{pid}":
            state["patched"] = True
        elif method == "GET" and path == f"{lib.BASE}/{pid}" and state["patched"]:
            state["gets"] += 1
            if state["gets"] > lib.SETTLE_READS:
                return on_get(state["gets"] - lib.SETTLE_READS, resp)
        return resp
    return do


def test_grants_after_adopt_refused_when_marker_removed_before_grants_step():
    api = FakeApi()
    pid = api.add("zz-b", TAGS)
    _, steps = plan(api, [pol("zz-b", users=["groups/g"])])
    assert actions(steps) == [("zz-b", "adopt"), ("zz-b", "grants")]

    def marker_removed(n, resp):
        unmark(api, pid)
        return api.policies[pid]

    c = lib.Client(ws_client(_after_adopt_verified(api, pid, marker_removed)), ACCT, sleep=lambda s: None)
    res = lib.apply_plan(c, steps, "t", ME, False)
    # The adopt itself was verified, but the final list check sees the marker gone, so it is unconfirmed.
    assert [(r["action"], r["status"]) for r in res] == [("adopt", "unconfirmed"), ("grants", "skipped")]
    assert "target changed since plan" in res[1]["message"]
    assert "PUT" not in mutations(api)


def test_grants_after_adopt_tolerates_one_stale_read_without_marker():
    api = FakeApi()
    pid = api.add("zz-b", TAGS)
    _, steps = plan(api, [pol("zz-b", users=["groups/g"])])
    pre_adopt = {**api.policies[pid]}

    def one_stale(n, resp):
        return pre_adopt if n == 1 else resp

    c = lib.Client(ws_client(_after_adopt_verified(api, pid, one_stale)), ACCT, sleep=lambda s: None)
    res = lib.apply_plan(c, steps, "t", ME, False)
    assert [(r["action"], r["status"]) for r in res] == [("adopt", "ok"), ("grants", "ok")]
    assert lib._principals(api.rules[pid]["grant_rules"], lib.USER_ROLE) == {"groups/g"}

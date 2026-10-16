"""Serverless usage policies as code: validate, plan, apply, import, chargeback.

Pure logic plus a thin client over the workspace-host `/api/2.0/serverless-policies`
route and the account access-control rule-set proxy. Every call goes through
`w.api_client.do` with the notebook user's own workspace credentials.
"""
import pprint
import re
import time
import uuid
from dataclasses import dataclass, field

from databricks.sdk.errors import AlreadyExists, DatabricksError, NotFound, ResourceAlreadyExists

BASE = "/api/2.0/serverless-policies"
RULE_SETS = "/api/2.0/preview/accounts/access-control/rule-sets"
MARKER_KEY = "managed_by"
MARKER_VALUE = "usage-policies-notebook"
USER_ROLE = "roles/budgetPolicy.user"
MANAGER_ROLE = "roles/budgetPolicy.manager"
ROLES = (USER_ROLE, MANAGER_ROLE)
SETTLE_READS = 3  # consecutive fresh reads before a change counts as applied
RESERVED_TAG_KEYS = {"budget-policy-name", "budget-policy-id", "budget-policy-resolution-result"}
MAX_TAGS = 20
MAX_NAME = 127
MAX_TAG_VALUE = 256
PRINCIPAL_RE = re.compile(r"^(users|groups|servicePrincipals)/.+$")


@dataclass
class Policy:
    name: str
    tags: dict
    workspace_ids: object = None  # None -> current workspace, "all" -> every workspace, or [int]
    users: list = field(default_factory=list)
    managers: list = field(default_factory=list)


def normalize(declared, current_workspace_id):
    """Dicts or Policy objects -> Policy with workspace_ids resolved to a sorted list."""
    out = []
    for d in declared:
        p = d if isinstance(d, Policy) else Policy(**d)
        ws = p.workspace_ids
        if ws is None:
            ws = [int(current_workspace_id)]
        elif ws == "all":
            ws = []
        elif isinstance(ws, (list, tuple)) and all(_is_int(i) for i in ws):
            ws = sorted({int(i) for i in ws})
        out.append(Policy(p.name, dict(p.tags or {}), ws, list(p.users or []), list(p.managers or [])))
    return out


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def validate(policies, required_tag_keys):
    """Return every validation error (empty list means valid)."""
    errs, seen = [], set()
    for p in policies:
        n = p.name if isinstance(p.name, str) else ""
        tag = f"[{n}]"
        if not n or len(n) > MAX_NAME:
            errs.append(f"{tag} name must be 1-{MAX_NAME} characters")
        if n in seen:
            errs.append(f"duplicate policy name '{n}'")
        seen.add(n)
        tags = p.tags if isinstance(p.tags, dict) else {}
        lowered = set()
        for k, v in tags.items():
            if not isinstance(k, str) or not k:
                errs.append(f"{tag} tag keys must be non-empty strings")
                continue
            if k.lower() in lowered:
                errs.append(f"{tag} duplicate tag key '{k.lower()}' (keys are case-insensitive)")
            lowered.add(k.lower())
            if k in RESERVED_TAG_KEYS:
                errs.append(f"{tag} tag key '{k}' is reserved")
            if k == MARKER_KEY:
                errs.append(f"{tag} tag '{MARKER_KEY}' is added automatically; do not declare it")
            if not isinstance(v, str):
                errs.append(f"{tag} tag '{k}' value must be a string")
            elif len(v) > MAX_TAG_VALUE:
                errs.append(f"{tag} tag '{k}' value exceeds {MAX_TAG_VALUE} characters")
        for k in required_tag_keys:
            if not tags.get(k):
                errs.append(f"{tag} missing required tag '{k}'")
        count = len(set(tags) | {MARKER_KEY})
        if count > MAX_TAGS:
            errs.append(f"{tag} {count} tags including the managed marker (max {MAX_TAGS})")
        for pr in list(p.users or []) + list(p.managers or []):
            if not isinstance(pr, str) or not PRINCIPAL_RE.match(pr):
                errs.append(f"{tag} invalid principal '{pr}' (use users/<email>, groups/<account group>, "
                            "or servicePrincipals/<applicationId>)")
        ws = p.workspace_ids
        if not (ws is None or ws == "all" or (isinstance(ws, (list, tuple)) and all(_is_int(i) for i in ws))):
            errs.append(f"{tag} workspace_ids must be omitted, \"all\", or a list of integer workspace IDs")
    return errs


# --- thin API client --------------------------------------------------------

def discover_account_id(w, override=None):
    """Account ID without account credentials.

    The workspace host serves `/.well-known/databricks-config` (the SDK's host
    metadata endpoint), which includes `account_id`. A non-empty override wins.
    """
    if override and override.strip():
        return override.strip()
    try:
        acct = (w.api_client.do("GET", "/.well-known/databricks-config") or {}).get("account_id")
    except DatabricksError:
        acct = None
    if not acct:
        raise RuntimeError("Could not discover the account ID from the workspace host; set the account_id widget.")
    return acct


def caller_principal(w):
    """`users/<email>` for a user, `servicePrincipals/<applicationId>` for a service principal."""
    name = w.api_client.do("GET", "/api/2.0/preview/scim/v2/Me")["userName"]
    return f"users/{name}" if "@" in name else f"servicePrincipals/{name}"


def desired_body(p):
    """The full flat policy object for a normalized Policy, marker included."""
    tags = {**p.tags, MARKER_KEY: MARKER_VALUE}
    return {
        "policy_name": p.name,
        "custom_tags": [{"key": k, "value": tags[k]} for k in sorted(tags)],
        "binding_workspace_ids": list(p.workspace_ids),
    }


class Client:
    def __init__(self, w, account_id, sleep=time.sleep, page_size=100):
        self._do = w.api_client.do
        self.account_id = account_id
        self.sleep = sleep
        self.page_size = page_size

    def list_policies(self):
        out, token = [], None
        while True:
            q = {"page_size": self.page_size}
            if token:
                q["page_token"] = token
            r = self._list_page(q)
            out.extend(r.get("policies", []))
            token = r.get("next_page_token")
            if not token:
                return out

    def _list_page(self, q, attempts=6, base_delay=1.0):
        # Shortly after a delete the list index can still reference the policy and the
        # whole list call fails with 404 "BudgetPolicy <id> not found". Retry that.
        for i in range(attempts):
            try:
                return self._do("GET", BASE, query=q) or {}
            except NotFound:
                if i == attempts - 1:
                    raise
                self.sleep(base_delay * 2 ** i)

    def get_policy(self, policy_id):
        return self._do("GET", f"{BASE}/{policy_id}")

    def create_policy(self, body, request_id):
        return self._do("POST", BASE, body={"policy": body, "request_id": request_id})

    def update_policy(self, policy_id, body):
        # Flat body, no update_mask: omitted fields would be cleared, so always send all of them.
        return self._do("PATCH", f"{BASE}/{policy_id}", body=dict(body))

    def delete_policy(self, policy_id):
        return self._do("DELETE", f"{BASE}/{policy_id}")

    def rule_set_name(self, policy_id):
        return f"accounts/{self.account_id}/budgetPolicies/{policy_id}/ruleSets/default"

    def get_rule_set(self, policy_id):
        return self._do("GET", RULE_SETS, query={"name": self.rule_set_name(policy_id), "etag": ""})

    def put_rule_set(self, policy_id, etag, grant_rules):
        n = self.rule_set_name(policy_id)
        return self._do("PUT", RULE_SETS, body={"name": n, "rule_set": {"name": n, "etag": etag, "grant_rules": grant_rules}})


# --- plan -------------------------------------------------------------------

@dataclass
class Step:
    name: str
    action: str  # create | adopt | update | grants | delete | no-op | error
    policy_id: str = None
    details: list = field(default_factory=list)
    body: dict = None
    grant_rules: list = None
    etag: str = None
    users: list = None
    managers: list = None
    error: str = None


def tags_of(live):
    return {t["key"]: t.get("value", "") for t in live.get("custom_tags") or []}


def is_managed(live):
    return tags_of(live).get(MARKER_KEY) == MARKER_VALUE


def field_diff(live, body):
    cur, new = tags_of(live), {t["key"]: t["value"] for t in body["custom_tags"]}
    out = []
    for k in sorted(set(cur) | set(new)):
        if k not in cur:
            out.append(f"+ tag {k}='{new[k]}'")
        elif k not in new:
            out.append(f"- tag {k}='{cur[k]}'")
        elif cur[k] != new[k]:
            out.append(f"~ tag {k}: '{cur[k]}' -> '{new[k]}'")
    cw = sorted(int(i) for i in live.get("binding_workspace_ids") or [])
    nw = sorted(body["binding_workspace_ids"])
    if cw != nw:
        out.append(f"~ workspaces: {_ws_label(cw)} -> {_ws_label(nw)}")
    return out


def _ws_label(ids):
    return str(ids) if ids else "all"


def _principals(rules, role):
    return {p for r in rules if r.get("role") == role for p in r.get("principals") or []}


def compute_grants(current_rules, users, managers, caller):
    """Authoritative User/Manager principals; other roles kept; caller's Manager grant never removed.

    Returns (new_grant_rules, details); details is empty when nothing changes.
    """
    current_rules = current_rules or []
    want = {USER_ROLE: set(users), MANAGER_ROLE: set(managers)}
    kept_caller = caller in _principals(current_rules, MANAGER_ROLE) and caller not in want[MANAGER_ROLE]
    if kept_caller:
        want[MANAGER_ROLE].add(caller)
    details = []
    for role, label in ((USER_ROLE, "users"), (MANAGER_ROLE, "managers")):
        cur = _principals(current_rules, role)
        details += [f"+ {label}: {p}" for p in sorted(want[role] - cur)]
        details += [f"- {label}: {p}" for p in sorted(cur - want[role])]
    new_rules = [r for r in current_rules if r.get("role") not in ROLES]
    new_rules += [{"role": role, "principals": sorted(want[role])} for role in ROLES if want[role]]
    if details and kept_caller:
        details.append(f"note: the caller's Manager grant is kept ({caller}); it is never removed")
    return new_rules, details


def build_plan(client, policies, caller, allow_deletes=False):
    """Diff normalized declared policies against live state. Errors are isolated per policy."""
    live = client.list_policies()
    by_name = {p["policy_name"]: p for p in live}
    steps = []
    for p in policies:
        body = desired_body(p)
        cur = by_name.get(p.name)
        if cur is None:
            steps.append(Step(p.name, "create", details=_create_details(body), body=body))
            if p.users or p.managers:
                _, d = compute_grants([], p.users, p.managers, caller)
                steps.append(Step(p.name, "grants", details=d, users=p.users, managers=p.managers))
            continue
        pid = cur["policy_id"]
        try:
            rs = client.get_rule_set(pid)
        except DatabricksError as e:
            steps.append(Step(p.name, "error", pid, error=f"cannot read grants: {e}"))
            continue
        diff = field_diff(cur, body)
        rules, gdetails = compute_grants(rs.get("grant_rules"), p.users, p.managers, caller)
        if not is_managed(cur):
            steps.append(Step(p.name, "adopt", pid, diff, body))
        elif diff:
            steps.append(Step(p.name, "update", pid, diff, body))
        if gdetails:
            steps.append(Step(p.name, "grants", pid, gdetails, grant_rules=rules, etag=rs.get("etag"),
                              users=p.users, managers=p.managers))
        if is_managed(cur) and not diff and not gdetails:
            steps.append(Step(p.name, "no-op", pid))
    declared = {p.name for p in policies}
    for cur in live:
        if is_managed(cur) and cur["policy_name"] not in declared:
            d = [] if allow_deletes else ["skipped unless allow_deletes=true"]
            steps.append(Step(cur["policy_name"], "delete", cur["policy_id"], d))
    return steps


def _create_details(body):
    d = [f"+ tag {t['key']}='{t['value']}'" for t in body["custom_tags"]]
    return d + [f"+ workspaces: {_ws_label(body['binding_workspace_ids'])}"]


def plan_rows(steps):
    return [{"policy": s.name, "action": s.action, "policy_id": s.policy_id or "",
             "details": s.error or "; ".join(s.details)} for s in steps]


# --- apply ------------------------------------------------------------------

def request_id(run_token, name):
    """Deterministic per (run, policy): a retried apply cell replays the same create."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"usage-policies-notebook/{run_token}/{name}"))


def retry(client, fn, ok=lambda v: True, attempts=6, base_delay=1.0, settle=1):
    """Bounded retry with exponential backoff for reads after writes.

    Reads are served by replicas that can be stale for a few seconds and can flip back to
    stale after one fresh read, so `settle` consecutive good reads are required.
    Returns (confirmed, last_value_or_error).
    """
    last, streak, misses = None, 0, 0
    while misses < attempts:
        try:
            last = fn()
            good = ok(last)
        except DatabricksError as e:
            last, good = e, False
        streak = streak + 1 if good else 0
        if streak >= settle:
            return True, last
        if not good:
            misses += 1
            if misses == attempts:
                break
            client.sleep(base_delay * 2 ** min(misses - 1, 4))
        else:
            client.sleep(base_delay)
    return False, last


def _matches(live, body):
    return not field_diff(live, body) and live.get("policy_name") == body["policy_name"]


def _same_grants(rules, want_rules):
    return all(_principals(rules or [], r) == _principals(want_rules, r) for r in ROLES)


def _gone(client, pid):
    try:
        client.get_policy(pid)
        return False
    except NotFound:
        return True


def apply_plan(client, steps, run_token, caller, allow_deletes):
    """Execute the plan, then re-read each change with retry.

    Each result has status ok | failed | skipped | unconfirmed. One failure does not stop the rest.
    """
    results, created = [], {}
    for s in steps:
        r = {"policy": s.name, "action": s.action, "policy_id": s.policy_id or "", "status": "ok", "message": ""}
        results.append(r)
        if s.action in ("no-op", "error"):
            r["status"] = "skipped"
            r["message"] = s.error or "nothing to do"
            continue
        if s.action == "delete" and not allow_deletes:
            r["status"], r["message"] = "skipped", "allow_deletes=false"
            continue
        pid = s.policy_id or created.get(s.name)
        if s.action == "grants" and not pid:
            r["status"], r["message"] = "skipped", "policy was not created"
            continue
        try:
            if s.action == "create":
                pid = client.create_policy(s.body, request_id(run_token, s.name))["policy_id"]
                created[s.name] = pid
                ok, _ = retry(client, lambda: client.get_policy(pid), lambda v: _matches(v, s.body), settle=SETTLE_READS)
            elif s.action in ("update", "adopt"):
                client.update_policy(pid, s.body)
                ok, _ = retry(client, lambda: client.get_policy(pid), lambda v: _matches(v, s.body), settle=SETTLE_READS)
            elif s.action == "delete":
                client.delete_policy(pid)
                ok, _ = retry(client, lambda: _gone(client, pid), bool, settle=SETTLE_READS)
            elif s.action == "grants":
                rules, etag = s.grant_rules, s.etag
                if rules is None:  # new policy: read its default rule set first
                    found, rs = retry(client, lambda: client.get_rule_set(pid))
                    if not found:
                        raise rs if isinstance(rs, Exception) else RuntimeError("rule set not readable")
                    rules, _ = compute_grants(rs.get("grant_rules"), s.users, s.managers, caller)
                    etag = rs.get("etag")
                client.put_rule_set(pid, etag, rules)
                ok, _ = retry(client, lambda: client.get_rule_set(pid),
                              lambda v: _same_grants(v.get("grant_rules"), rules), settle=SETTLE_READS)
            r["policy_id"] = pid
            if not ok:
                r["status"], r["message"] = "unconfirmed", "change sent; re-read did not reflect it yet"
        except (AlreadyExists, ResourceAlreadyExists) as e:
            r["status"] = "failed"
            r["message"] = f"{e} (the list was stale when planned; wait a moment and re-run the plan)"
        except (DatabricksError, RuntimeError) as e:
            r["status"], r["message"] = "failed", str(e)
    _wait_for_list(client, steps, results)
    return results


def _wait_for_list(client, steps, results):
    """The list (which the next plan reads) lags behind GET; poll until it reflects every change."""
    bodies = {s.name: s.body for s in steps if s.body}
    pending = [r for r in results if r["status"] == "ok" and r["action"] in ("create", "update", "adopt", "delete")]
    if not pending:
        return

    def reflected(live, r):
        by_id = {p["policy_id"]: p for p in live}
        if r["action"] == "delete":
            return r["policy_id"] not in by_id
        cur = by_id.get(r["policy_id"])
        return cur is not None and _matches(cur, bodies[r["policy"]])

    ok, live = retry(client, client.list_policies, lambda v: all(reflected(v, r) for r in pending),
                     settle=SETTLE_READS)
    for r in pending:
        if not ok and (isinstance(live, Exception) or not reflected(live, r)):
            r["status"], r["message"] = "unconfirmed", "applied, but the policy list is not consistent yet; re-run the plan"


def managed_state(client):
    """Rows for every visible policy carrying the managed marker."""
    return [{"policy": p["policy_name"], "policy_id": p["policy_id"],
             "tags": {k: v for k, v in tags_of(p).items() if k != MARKER_KEY},
             "workspaces": _ws_label(sorted(p.get("binding_workspace_ids") or []))}
            for p in sorted(client.list_policies(), key=lambda p: p["policy_name"]) if is_managed(p)]


# --- import -----------------------------------------------------------------

def export_policies(client, current_workspace_id):
    """Visible policies as a ready-to-paste `POLICIES = [...]` literal (adopt by apply)."""
    lines = ["POLICIES = ["]
    for p in sorted(client.list_policies(), key=lambda p: p["policy_name"]):
        d = {"name": p["policy_name"], "tags": {k: v for k, v in tags_of(p).items() if k != MARKER_KEY}}
        ws = sorted(int(i) for i in p.get("binding_workspace_ids") or [])
        if not ws:
            d["workspace_ids"] = "all"
        elif ws != [int(current_workspace_id)]:
            d["workspace_ids"] = ws
        try:
            rules = client.get_rule_set(p["policy_id"]).get("grant_rules") or []
            d["users"] = sorted(_principals(rules, USER_ROLE))
            d["managers"] = sorted(_principals(rules, MANAGER_ROLE))
        except DatabricksError as e:
            lines.append(f"    # {p['policy_name']}: grants not readable ({type(e).__name__}); "
                         "declaring users/managers makes them authoritative")
        body = pprint.pformat(d, sort_dicts=False, width=100)
        lines.append("    " + body.replace("\n", "\n    ") + ",")
    lines.append("]")
    return "\n".join(lines)


# --- chargeback -------------------------------------------------------------

CHARGEBACK_SQL = """
SELECT
  u.usage_date,
  COALESCE(u.usage_metadata.usage_policy_id, u.usage_metadata.budget_policy_id) AS policy_id,
  u.custom_tags,
  u.sku_name,
  u.usage_quantity AS dbus,
  u.usage_quantity * CAST(p.pricing.default AS DOUBLE) AS est_list_cost
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND u.usage_unit = p.usage_unit
  AND u.usage_end_time >= p.price_start_time
  AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
WHERE u.usage_date BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)
  AND COALESCE(u.usage_metadata.usage_policy_id, u.usage_metadata.budget_policy_id) IS NOT NULL
"""


def chargeback_dates(start, end, today=None):
    """Validated ISO dates; blank defaults to the last 30 days."""
    import datetime as dt
    today = today or dt.date.today()
    try:
        e = dt.date.fromisoformat(end) if end else today
        s = dt.date.fromisoformat(start) if start else e - dt.timedelta(days=30)
    except ValueError as err:
        raise ValueError(f"chargeback dates must be YYYY-MM-DD: {err}") from None
    if s > e:
        raise ValueError(f"chargeback_start_date {s} is after chargeback_end_date {e}")
    return s.isoformat(), e.isoformat()

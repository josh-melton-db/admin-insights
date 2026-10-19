import ast
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


SOURCE = Path(__file__).parents[1] / "src" / "budgets_lib.py"
spec = importlib.util.spec_from_file_location("budgets_lib", SOURCE)
lib = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lib)


def declaration(**changes):
    return {"name": "example-team", "amount": "100", "notification_emails": [], **changes}


def prepared(*entries):
    budgets, errors = lib.prepare(list(entries))
    assert not errors, errors
    return budgets


class FakeApi:
    def __init__(self):
        self.budgets = {}
        self.calls = []
        self.next_id = 1

    def add(self, entry=None):
        budget_id = str(self.next_id)
        self.next_id += 1
        self.budgets[budget_id] = {
            **lib.desired_body(prepared(entry or declaration())[0]),
            "budget_configuration_id": budget_id,
            "update_time": 1,
        }
        return budget_id

    def do(self, method, path, query=None, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        budget_id = path.rsplit("/", 1)[-1]
        if method == "GET" and path.endswith("/budgets"):
            return {"budgets": copy.deepcopy(list(self.budgets.values()))}
        if method == "GET":
            return {"budget": copy.deepcopy(self.budgets[budget_id])}
        if method == "POST":
            budget_id = str(self.next_id)
            self.next_id += 1
            self.budgets[budget_id] = {**copy.deepcopy(body["budget"]), "budget_configuration_id": budget_id}
            return {"budget": copy.deepcopy(self.budgets[budget_id])}
        if method == "PUT":
            self.budgets[budget_id] = copy.deepcopy(body["budget"])
            return {"budget": copy.deepcopy(self.budgets[budget_id])}
        if method == "DELETE":
            del self.budgets[budget_id]
            return {}
        raise AssertionError(method)


def client(api):
    return lib.Client(SimpleNamespace(api_client=api), "example-account")


@pytest.mark.parametrize("change", [
    {"name": ""}, {"name": "a" * 129}, {"name": 1}, {"amount": "NaN"},
    {"amount": "Infinity"}, {"amount": "-1"}, {"amount": "0"}, {"amount": True},
    {"amount": None}, {"amount": []}, {"amount": "nope"},
    {"notification_emails": "not-a-list"}, {"notification_emails": ["invalid"]},
    {"notification_emails": [1]}, {"workspace_ids": [True]}, {"workspace_ids": [-1]},
    {"workspace_ids": []}, {"workspace_ids": "all"}, {"tags": []},
    {"tags": {"": ["x"]}}, {"tags": {"team": []}}, {"tags": {"team": [1]}},
    {"tags": {"team": "x"}}, {"time_period": "YEAR"}, {"quantity_type": "DBU"},
    {"trigger_type": "OTHER"}, {"budget_id": "../bad"}, {"budget_id": True},
    {"adopt": "true"}, {"adopt": True}, {"unknown": "field"},
])
def test_invalid_declarations(change):
    assert lib.prepare([declaration(**change)])[1]


def test_collects_all_errors_without_echoing_values():
    _, errors = lib.prepare([None, {}, declaration(name="", amount=-1, notification_emails=["private-value"])])
    assert len(errors) >= 6
    assert "private-value" not in str(errors)
    assert lib.prepare({})[1]


def test_duplicate_names_and_ids():
    assert lib.prepare([declaration(), declaration()])[1]
    assert lib.prepare([declaration(budget_id="1"), declaration(name="example-other", budget_id="1")])[1]


def test_real_wire_schema_and_canonicalization():
    budget = prepared(declaration(workspace_ids=[2, 1, 2], tags={"Team": ["b", "a"]}))[0]
    body = lib.desired_body(budget)
    assert body["display_name"] == "example-team"
    assert body["filter"] == {
        "workspace_id": {"operator": "IN", "values": [1, 2]},
        "tags": [{"key": "Team", "value": {"operator": "IN", "values": ["a", "b"]}}],
    }
    alert = body["alert_configurations"][0]
    assert alert["quantity_threshold"] == "100"
    assert alert["time_period"] == "MONTH"
    assert alert["quantity_type"] == "LIST_PRICE_DOLLARS_USD"
    assert alert["trigger_type"] == "CUMULATIVE_SPENDING_EXCEEDED"


def test_dry_run_and_import_are_get_only():
    api = FakeApi()
    api.add()
    steps = lib.build_plan(client(api), prepared(declaration(name="example-new")), [])
    assert [step["action"] for step in steps] == ["create"]
    assert lib.apply_plan(client(api), steps, apply=False) == []
    literal = lib.export_budgets(client(api))
    exported = ast.literal_eval(literal.split("=", 1)[1])
    assert exported[0]["budget_id"] == "1"
    assert exported[0]["adopt"] is False
    assert {call[0] for call in api.calls} == {"GET"}


def test_same_name_never_implicitly_adopts():
    api = FakeApi()
    api.add()
    steps = lib.build_plan(client(api), prepared(declaration()), [])
    assert steps[0]["action"] == "error"
    assert lib.apply_plan(client(api), steps, apply=True)[0]["status"] == "skipped"


def test_explicit_adoption_required_and_full_put():
    api = FakeApi()
    budget_id = api.add()
    unadopted = prepared(declaration(budget_id=budget_id, amount="200"))
    assert lib.build_plan(client(api), unadopted, [])[0]["action"] == "error"
    adopted = prepared(declaration(budget_id=budget_id, adopt=True, amount="200"))
    steps = lib.build_plan(client(api), adopted, [])
    assert steps[0]["action"] == "adopt"
    results = lib.apply_plan(client(api), steps, apply=True)
    assert results[0]["status"] == "ok"
    put = next(call for call in api.calls if call[0] == "PUT")
    assert put[2]["budget"]["budget_configuration_id"] == budget_id
    assert "filter" in put[2]["budget"]
    assert "alert_configurations" in put[2]["budget"]


@pytest.mark.parametrize("apply,allow_deletes,deleted", [(False, False, False), (False, True, False), (True, False, False), (True, True, True)])
def test_both_delete_gates(apply, allow_deletes, deleted):
    api = FakeApi()
    budget_id = api.add()
    api.add(declaration(name="example-unmanaged"))
    steps = lib.build_plan(client(api), [], [budget_id])
    assert [step["action"] for step in steps] == ["delete"]
    lib.apply_plan(client(api), steps, apply=apply, allow_deletes=allow_deletes)
    assert (budget_id not in api.budgets) == deleted
    assert "2" in api.budgets


def test_managed_update_and_noop():
    api = FakeApi()
    budget_id = api.add()
    desired = prepared(declaration(budget_id=budget_id))
    assert lib.build_plan(client(api), desired, [budget_id])[0]["action"] == "no-op"
    desired[0]["amount"] = "300"
    steps = lib.build_plan(client(api), desired, [budget_id])
    assert steps[0]["action"] == "update"
    assert lib.apply_plan(client(api), steps, apply=True)[0]["status"] == "ok"
    assert lib.build_plan(client(api), desired, [budget_id])[0]["action"] == "no-op"


def test_create_and_followup_ownership_is_explicit():
    api = FakeApi()
    steps = lib.build_plan(client(api), prepared(declaration()), [])
    results = lib.apply_plan(client(api), steps, apply=True)
    assert results[0]["status"] == "ok"
    assert results[0]["budget_id"] == "1"
    assert lib.build_plan(client(api), [], []) == []


@pytest.mark.parametrize("action", ["update", "delete"])
def test_stale_plans_refuse_mutation(action):
    api = FakeApi()
    budget_id = api.add()
    desired = [] if action == "delete" else prepared(declaration(budget_id=budget_id, amount="200"))
    steps = lib.build_plan(client(api), desired, [budget_id])
    api.budgets[budget_id]["update_time"] = 2
    result = lib.apply_plan(client(api), steps, apply=True, allow_deletes=True)
    assert result[0]["status"] == "failed"
    assert {call[0] for call in api.calls} == {"GET"}


def test_create_collision_after_plan_is_refused():
    api = FakeApi()
    steps = lib.build_plan(client(api), prepared(declaration()), [])
    api.add()
    assert lib.apply_plan(client(api), steps, apply=True)[0]["status"] == "failed"
    assert {call[0] for call in api.calls} == {"GET"}


def test_pagination_and_repeated_token_fail_closed():
    calls = []

    def paged(method, path, query=None, **kwargs):
        calls.append(query)
        return {"budgets": [{"budget_configuration_id": str(len(calls))}], "next_page_token": "next"} if len(calls) == 1 else {"budgets": []}

    api = SimpleNamespace(api_client=SimpleNamespace(do=paged))
    assert len(lib.Client(api, "example-account").list()) == 1
    assert calls == [{}, {"page_token": "next"}]
    api.api_client.do = lambda *args, **kwargs: {"budgets": [], "next_page_token": "repeat"}
    with pytest.raises(lib.BudgetError):
        lib.Client(api, "example-account").list()


def test_read_failure_and_unsupported_budget_fail_closed():
    api = FakeApi()
    budget_id = api.add()
    api.budgets[budget_id]["alert_configurations"][0]["action_configurations"] = [{"action_type": "BLOCK_USAGE"}]
    steps = lib.build_plan(client(api), prepared(declaration(budget_id=budget_id, adopt=True)), [])
    assert steps[0]["action"] == "error"
    exported = lib.export_budgets(client(api))
    assert "skipped 1 unsupported" in exported


def test_error_messages_never_echo_remote_response():
    def fail(*args, **kwargs):
        raise RuntimeError("sensitive-token-and-email")

    api = SimpleNamespace(api_client=SimpleNamespace(do=fail))
    with pytest.raises(lib.BudgetError) as error:
        lib.Client(api, "example-account").list()
    assert "sensitive" not in str(error.value)


def test_report_query_parameters_and_missing_prices():
    desired = prepared(declaration(workspace_ids=[1], tags={"a' OR true": ["x' OR true"]}))[0]
    sql, parameters = lib.report_query(desired, "2026-01-01", "2026-03-01", "example-account")
    assert "system.billing.usage" in sql and "system.billing.list_prices" in sql
    assert "LEFT JOIN" in sql and "unpriced_rows" in sql
    assert "price_start_time" in sql and "usage_unit" in sql and "p.cloud = u.cloud" in sql
    assert "p.currency_code = 'USD'" in sql
    assert "u.account_id = :account_id" in sql
    assert "a' OR true" not in sql and "x' OR true" not in sql
    assert "2026-01-01" not in sql
    assert parameters["start_date"] == "2026-01-01"
    assert "month" in sql.lower()


@pytest.mark.parametrize("start,end", [("nope", "2026-01-01"), ("2026-02-01", "2026-01-01"), ("2026-01-01", "2026-01-01")])
def test_invalid_report_range(start, end):
    with pytest.raises(ValueError):
        lib.report_query(prepared(declaration())[0], start, end, "example-account")


def test_account_auth_no_workspace_fallback(monkeypatch):
    monkeypatch.delenv("DATABRICKS_ACCOUNT_PROFILE", raising=False)
    with pytest.raises(ValueError):
        lib.account_client()
    with pytest.raises(ValueError):
        lib.account_client(in_runtime=True, account_id="example-account", secret_scope="", secret_key="")


def test_account_host_allowlist():
    for host in ("https://example.cloud.databricks.com", "http://accounts.cloud.databricks.com", "https://accounts.cloud.databricks.com.evil.test"):
        with pytest.raises(ValueError):
            lib.validate_account_config(SimpleNamespace(host=host, account_id="example-account", profile="explicit"))


def test_import_roundtrip_preserves_supported_filters():
    api = FakeApi()
    api.add(declaration(workspace_ids=[1, 2], tags={"Team": ["a", "b"]}))
    exported = ast.literal_eval(lib.export_budgets(client(api)).split("=", 1)[1])
    assert not lib.prepare(exported)[1]
    assert lib.desired_body(prepared(*exported)[0]) == lib.desired_body(prepared(declaration(workspace_ids=[1, 2], tags={"Team": ["a", "b"]}))[0])


def test_live_default_metadata_is_not_an_ownership_marker():
    api = FakeApi()
    budget_id = api.add()
    live = api.budgets[budget_id]
    live.update(name="resource-name", workspace_id=0, backfilled_usage_start_time=0,
                streaming_ingestion_start_time=0, include_external_spend=False,
                pricing_basis="BUDGET_PRICING_BASIS_LIST_PRICE",
                product_type="BUDGET_PRODUCT_TYPE_ALL_PRODUCTS",
                resource_type="BUDGET_RESOURCE_TYPE_ALL_RESOURCES")
    live["alert_configurations"][0].update(create_time=0, update_time=0,
                                         scope_type="ALERT_CONFIGURATION_SCOPE_TYPE_SHARED")
    assert lib.declaration_from_live(live)["adopt"] is False


@pytest.mark.parametrize("change", [
    {"include_external_spend": True}, {"pricing_basis": "OTHER"},
    {"product_type": "BUDGET_PRODUCT_TYPE_UNITY_AI_GATEWAY"},
    {"resource_type": "BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY"}, {"new_mutable_field": True},
])
def test_new_or_scoped_features_cannot_be_silently_erased(change):
    api = FakeApi()
    budget_id = api.add()
    api.budgets[budget_id].update(change)
    with pytest.raises(lib.BudgetError):
        lib.declaration_from_live(api.budgets[budget_id])


def test_nonobject_response_is_sanitized():
    api = SimpleNamespace(api_client=SimpleNamespace(do=lambda *args, **kwargs: ["private-value"]))
    with pytest.raises(lib.BudgetError):
        lib.Client(api, "example-account").list()


def test_runtime_secret_auth_is_explicit_and_account_only(monkeypatch):
    import databricks.sdk
    import databricks.sdk.core

    captured = {}
    reads = []

    def config(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(**kwargs)

    def secret(**kwargs):
        reads.append(kwargs)
        return "example-secret-token"

    monkeypatch.setattr(databricks.sdk.core, "Config", config)
    monkeypatch.setattr(databricks.sdk, "AccountClient", lambda config: SimpleNamespace(api_client=FakeApi()))
    result = lib.account_client(in_runtime=True, account_id="example-account", secret_scope="example-scope",
                                secret_key="example-key", dbutils=SimpleNamespace(secrets=SimpleNamespace(get=secret)))
    assert result.account_id == "example-account"
    assert reads == [{"scope": "example-scope", "key": "example-key"}]
    assert captured["auth_type"] == "pat" and captured["token"] == "example-secret-token"
    assert "profile" not in captured


def test_local_auth_uses_only_explicit_account_profile(monkeypatch):
    import databricks.sdk
    import databricks.sdk.core

    captured = {}

    def config(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(host="https://accounts.cloud.databricks.com", account_id=kwargs.get("account_id", "example-account"))

    monkeypatch.setenv("DATABRICKS_ACCOUNT_PROFILE", "example-account-profile")
    monkeypatch.setenv("DATABRICKS_CONFIG_PROFILE", "example-workspace-profile")
    monkeypatch.setattr(databricks.sdk.core, "Config", config)
    monkeypatch.setattr(databricks.sdk, "AccountClient", lambda config: SimpleNamespace(api_client=FakeApi()))
    assert lib.account_client(account_id="example-override").account_id == "example-override"
    assert captured["profile"] == "example-account-profile"


def test_runtime_invalid_host_does_not_read_secret():
    reads = []
    dbutils = SimpleNamespace(secrets=SimpleNamespace(get=lambda **kwargs: reads.append(kwargs)))
    with pytest.raises(ValueError):
        lib.account_client(in_runtime=True, account_id="example-account", secret_scope="example-scope",
                           secret_key="example-key", account_host="https://example.invalid", dbutils=dbutils)
    assert reads == []


def test_create_failure_does_not_retry_or_print_private_details():
    api = FakeApi()
    original = api.do
    attempts = []

    def fail_create(method, path, **kwargs):
        if method == "POST":
            attempts.append(method)
            raise RuntimeError("private-api-response")
        return original(method, path, **kwargs)

    api.do = fail_create
    target = client(api)
    steps = lib.build_plan(target, prepared(declaration()), [])
    results = lib.apply_plan(target, steps, apply=True)
    assert attempts == ["POST"]
    assert results[0]["status"] == "failed"
    assert "private" not in str(results)


def test_unconfirmed_create_keeps_returned_id_for_recovery():
    api = FakeApi()
    original = api.do

    def stale_get(method, path, **kwargs):
        if method == "GET" and not path.endswith("/budgets"):
            return {}
        return original(method, path, **kwargs)

    api.do = stale_get
    target = client(api)
    steps = lib.build_plan(target, prepared(declaration()), [])
    result = lib.apply_plan(target, steps, apply=True, sleep=lambda duration: None)[0]
    assert result["status"] == "unconfirmed" and result["budget_id"] == "1"

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
    budgets, errors = lib.prepare(list(entries), workspace_id=101)
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
    budget = prepared(declaration(scope="account", workspace_ids=[2, 1, 2], tags={"Team": ["b", "a"]}))[0]
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
    api.budgets[budget_id]["alert_configurations"][0]["action_configurations"] = [{"action_type": "UNKNOWN_ACTION"}]
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
    desired = prepared(declaration(workspace_id=1, workspace_ids=[1], tags={"a' OR true": ["x' OR true"]}))[0]
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


def test_account_host_allowlist():
    for host in ("https://example.cloud.databricks.com", "http://accounts.cloud.databricks.com", "https://accounts.cloud.databricks.com.evil.test"):
        with pytest.raises(ValueError):
            lib.validate_account_config(SimpleNamespace(host=host, account_id="example-account", profile="explicit"))


def test_import_roundtrip_preserves_supported_filters():
    api = FakeApi()
    api.add(declaration(scope="account", workspace_ids=[1, 2], tags={"Team": ["a", "b"]}))
    exported = ast.literal_eval(lib.export_budgets(client(api)).split("=", 1)[1])
    assert not lib.prepare(exported)[1]
    assert lib.desired_body(prepared(*exported)[0]) == lib.desired_body(prepared(declaration(scope="account", workspace_ids=[1, 2], tags={"Team": ["a", "b"]}))[0])


def test_live_default_metadata_is_not_an_ownership_marker():
    api = FakeApi()
    budget_id = api.add()
    live = api.budgets[budget_id]
    live.update(name="resource-name", workspace_id=101, backfilled_usage_start_time=0,
                streaming_ingestion_start_time=0, include_external_spend=False,
                pricing_basis="BUDGET_PRICING_BASIS_LIST_PRICE",
                product_type="BUDGET_PRODUCT_TYPE_ALL_PRODUCTS",
                resource_type="BUDGET_RESOURCE_TYPE_ALL_RESOURCES")
    live["alert_configurations"][0].update(create_time=0, update_time=0,
                                         scope_type="ALERT_CONFIGURATION_SCOPE_TYPE_SHARED")
    assert lib.declaration_from_live(live)["adopt"] is False


@pytest.mark.parametrize("change", [
    {"pricing_basis": "OTHER"}, {"product_type": "OTHER"},
    {"resource_type": "OTHER"}, {"new_mutable_field": True},
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


def test_workspace_scope_defaults_to_runtime_workspace():
    budget = prepared(declaration())[0]
    body = lib.desired_body(budget)
    assert budget["scope"] == "workspace"
    assert body["workspace_id"] == 101
    assert body["filter"]["workspace_id"] == {"operator": "IN", "values": [101]}
    assert body["resource_type"] == "BUDGET_RESOURCE_TYPE_ALL_RESOURCES"
    assert lib.prepare([declaration()])[1]


def test_account_scope_is_explicit_opt_in():
    budgets, errors = lib.prepare([declaration(scope="account")])
    assert not errors
    body = lib.desired_body(budgets[0])
    assert "workspace_id" not in body and "workspace_id" not in body["filter"]


@pytest.mark.parametrize("change", [
    {"scope": "other"}, {"workspace_id": True}, {"workspace_id": -1},
    {"scope": "account", "workspace_id": 101}, {"workspace_ids": [102]},
    {"resource_type": "unknown"}, {"product_type": "unknown"}, {"include_external_spend": "false"},
])
def test_scope_validation(change):
    assert lib.prepare([declaration(**change)], workspace_id=101)[1]


def test_scoped_budget_import_plan_apply_roundtrip():
    api = FakeApi()
    budget_id = api.add(declaration(workspace_id=202, resource_type="BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY"))
    exported = ast.literal_eval(lib.export_budgets(client(api)).split("BUDGETS = ", 1)[1])
    assert exported[0]["workspace_id"] == 202
    assert exported[0]["scope"] == "workspace"
    desired = prepared(*exported)
    assert lib.build_plan(client(api), desired, [budget_id])[0]["action"] == "no-op"
    desired[0]["amount"] = "200"
    steps = lib.build_plan(client(api), desired, [budget_id])
    assert lib.apply_plan(client(api), steps, apply=True)[0]["status"] == "ok"
    wire = next(call[2]["budget"] for call in api.calls if call[0] == "PUT")
    assert "workspace_id" not in wire
    assert wire["filter"]["workspace_id"]["values"] == [202]
    assert wire["resource_type"] == "BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY"


def test_multi_alert_per_user_import_preserves_semantics():
    api = FakeApi()
    budget_id = api.add()
    live = api.budgets[budget_id]
    shared = live["alert_configurations"][0]
    shared.update(scope_type="ALERT_CONFIGURATION_SCOPE_TYPE_SHARED", alert_configuration_id="example-shared")
    per_user = {**copy.deepcopy(shared), "scope_type": "ALERT_CONFIGURATION_SCOPE_TYPE_PER_USER",
                "alert_configuration_id": "example-per-user", "quantity_threshold": "20",
                "principal_overrides": [{"principal_id": 1, "override_threshold": "30"}]}
    live["alert_configurations"].append(per_user)
    exported = ast.literal_eval(lib.export_budgets(client(api)).split("BUDGETS = ", 1)[1])
    assert len(exported[0]["alerts"]) == 2
    assert exported[0]["alerts"][1]["principal_overrides"] == per_user["principal_overrides"]
    desired = prepared(*exported)
    assert lib.build_plan(client(api), desired, [budget_id])[0]["action"] == "no-op"
    desired[0]["alerts"][1]["quantity_threshold"] = "25"
    steps = lib.build_plan(client(api), desired, [budget_id])
    assert lib.apply_plan(client(api), steps, apply=True)[0]["status"] == "ok"
    assert len(api.budgets[budget_id]["alert_configurations"]) == 2


@pytest.mark.parametrize("alerts", [[], "bad", [None], [{"quantity_threshold": "-1"}],
    [{"quantity_threshold": "1", "scope_type": "unknown"}],
    [{"quantity_threshold": "1", "action_configurations": [{"action_type": "UNKNOWN_ACTION"}]}],
])
def test_advanced_alert_validation(alerts):
    assert lib.prepare([{"name": "example-alerts", "alerts": alerts}], workspace_id=101)[1]


def test_blocking_actions_and_overrides_roundtrip():
    entry = {"name": "example-gateway", "resource_type": lib.AI_RESOURCES, "alerts": [{
        "quantity_threshold": "10", "scope_type": lib.PER_USER,
        "action_configurations": [{"action_type": "BLOCK_USAGE", "notify_affected_user": False}],
        "principal_overrides": [{"principal_id": 1, "override_threshold": "20"}],
    }]}
    api = FakeApi()
    budget_id = api.add(entry)
    exported = ast.literal_eval(lib.export_budgets(client(api)).split("BUDGETS = ", 1)[1])
    assert lib.desired_body(prepared(*exported)[0]) == lib.desired_body(prepared(entry)[0])
    assert lib.build_plan(client(api), prepared(*exported), [budget_id])[0]["action"] == "no-op"


@pytest.mark.parametrize("scope", [lib.SHARED, lib.PER_USER])
def test_advanced_report_thresholds(scope):
    budget = prepared({"name": "example-alerts", "alerts": [{"quantity_threshold": "20", "scope_type": scope}]})[0]
    if scope == lib.PER_USER:
        with pytest.raises(ValueError, match="per-user"):
            lib.report_query(budget, "2026-01-01", "2026-02-01", "example-account")
    else:
        _, parameters = lib.report_query(budget, "2026-01-01", "2026-02-01", "example-account")
        assert parameters["budget_amount"] == "20"


def test_gateway_report_refuses_to_present_all_product_spend_as_gateway_cost():
    budget = prepared(declaration(resource_type=lib.AI_RESOURCES))[0]
    with pytest.raises(ValueError, match="resource"):
        lib.report_query(budget, "2026-01-01", "2026-02-01", "example-account")


def test_workspace_create_uses_filter_not_read_only_resource_workspace_field():
    api = FakeApi()
    target = client(api)
    steps = lib.build_plan(target, prepared(declaration()), [])
    assert lib.apply_plan(target, steps, apply=True)[0]["status"] == "ok"
    body = next(call[2]["budget"] for call in api.calls if call[0] == "POST")
    assert "workspace_id" not in body
    assert "product_type" not in body
    assert "pricing_basis" not in body
    assert "include_external_spend" not in body
    assert body["filter"]["workspace_id"]["values"] == [101]


def test_legacy_workspace_scoped_response_can_infer_scope_from_filter():
    api = FakeApi()
    budget_id = api.add()
    api.budgets[budget_id].pop("workspace_id")
    assert lib.declaration_from_live(api.budgets[budget_id])["workspace_id"] == 101

from types import SimpleNamespace
from unittest.mock import Mock
from pathlib import Path
import sys

import pytest

from test_budgets_lib import lib, FakeApi, client, declaration, prepared


def consent():
    return SimpleNamespace(
        authorization_url="https://example.invalid/authorize?state=example-state",
        exchange=Mock(return_value=SimpleNamespace(token=Mock())),
    )


@pytest.mark.parametrize("runtime,mode,expected", [
    (True, None, "interactive"), (True, "interactive", "interactive"),
    (True, "secret", "secret"), (False, None, "profile"),
    (False, "interactive", "profile"),
])
def test_mode_selection(runtime, mode, expected):
    assert lib.account_auth_mode(runtime, mode) == expected


def test_invalid_mode():
    with pytest.raises(ValueError, match="account_auth"):
        lib.account_auth_mode(True, "workspace")


@pytest.mark.parametrize("value", [
    "example-code", "  example-code  ",
    "http://localhost:8020?code=example-code&state=example-state",
    "http://localhost:8020/?state=example-state&code=example-code",
])
def test_redirect_and_code_exchange(value):
    pending = consent()
    assert lib.exchange_account_signin(pending, value) is pending.exchange.return_value
    pending.exchange.assert_called_once_with("example-code", "example-state")


@pytest.mark.parametrize("value", [
    "", " ", "http://localhost:8020?state=example-state",
    "http://localhost:8020?code=example-code&state=wrong-state",
    "http://localhost:8020?code=example-code",
    "http://localhost:8020?code=one&code=two&state=example-state",
    "http://localhost:8020?code=example-code&state=example-state&error=access_denied",
    "https://example.invalid/?code=example-code&state=example-state",
])
def test_bad_callback_never_exchanges_or_echoes(value):
    pending = consent()
    with pytest.raises(ValueError, match="sign-in cell") as error:
        lib.exchange_account_signin(pending, value)
    pending.exchange.assert_not_called()
    assert "example-code" not in str(error.value)
    assert "wrong-state" not in str(error.value)


def test_stale_or_reused_code_is_sanitized():
    pending = consent()
    pending.exchange.side_effect = RuntimeError("private response")
    with pytest.raises(lib.BudgetError, match="stale or reused") as error:
        lib.exchange_account_signin(pending, "example-code")
    assert "private response" not in str(error.value)


def test_consent_uses_real_sdk_account_public_client():
    from urllib.parse import parse_qs, urlparse

    result = lib.initiate_account_signin("https://accounts.cloud.databricks.com", "example-account")
    assert result.authorization_url.startswith(
        "https://accounts.cloud.databricks.com/oidc/accounts/example-account/"
    )
    parameters = parse_qs(urlparse(result.authorization_url).query)
    assert parameters["client_id"] == ["databricks-cli"]
    assert parameters["redirect_uri"] == ["http://localhost:8020"]
    assert parameters["scope"] == ["all-apis offline_access"]
    assert parameters["code_challenge_method"] == ["S256"]
    with pytest.raises(ValueError):
        lib.initiate_account_signin("https://example.invalid", "example-account")


def test_notebook_installs_sdk_and_restarts_before_python_cells():
    source = (Path(__file__).parents[1] / "src" / "manage_budgets.py").read_text()
    cells = source.split("# COMMAND ----------")
    assert "# MAGIC %pip install --upgrade databricks-sdk" in cells[0]
    assert "# MAGIC %restart_python" in cells[1]
    assert source.index("%restart_python") < source.index("BUDGETS =")
    assert source.index("%restart_python") < source.index("from databricks.sdk")


@pytest.mark.parametrize("mode", ["secret", "profile"])
@pytest.mark.parametrize("error_type", [ValueError, lib.BudgetError])
def test_noninteractive_auth_failures_raise_without_notebook_exit(monkeypatch, mode, error_type):
    failure = error_type("Explicit credentials failed")
    monkeypatch.setattr(lib, "account_client", Mock(side_effect=failure))
    source = (Path(__file__).parents[1] / "src" / "manage_budgets.py").read_text()
    exchange_cell = next(cell for cell in source.split("# COMMAND ----------")
                         if 'if AUTH_MODE == "interactive" and (' in cell)
    notebook_exit = Mock(side_effect=RuntimeError("Unexpected successful notebook exit"))
    widgets = SimpleNamespace(get=lambda name: "example", remove=Mock())
    namespace = {"lib": lib, "AUTH_MODE": mode, "IN_RUNTIME": mode == "secret",
                 "account_consent": None,
                 "dbutils": SimpleNamespace(widgets=widgets, notebook=SimpleNamespace(exit=notebook_exit))}
    with pytest.raises(error_type) as caught:
        exec(compile(exchange_cell, "signin_cell", "exec"), namespace)
    assert caught.value is failure
    notebook_exit.assert_not_called()
    widgets.remove.assert_not_called()


def test_runtime_session_provider_is_refreshable_and_explicit(monkeypatch):
    import databricks.sdk
    import databricks.sdk.core

    captured = {}

    def config(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(**kwargs)

    monkeypatch.setattr(databricks.sdk.core, "Config", config)
    monkeypatch.setattr(databricks.sdk, "AccountClient", lambda config: SimpleNamespace(api_client=FakeApi()))
    session = SimpleNamespace(token=Mock(side_effect=[
        SimpleNamespace(access_token="example-first"), SimpleNamespace(access_token="example-next"),
    ]))
    lib.account_client(in_runtime=True, account_id="example-account", session_credentials=session)
    assert "token" not in captured and "profile" not in captured
    headers = captured["credentials_strategy"](SimpleNamespace(group_id=None, **captured))
    assert headers()["Authorization"] == "Bearer example-first"
    assert headers()["Authorization"] == "Bearer example-next"
    assert session.token.call_count == 2


def test_unchanged_adopt_is_registry_only():
    api = FakeApi()
    budget_id = api.add()
    steps = lib.build_plan(client(api), prepared(declaration(budget_id=budget_id, adopt=True)), [])
    assert steps[0]["action"] == "adopt"
    result = lib.apply_plan(client(api), steps, apply=True)
    assert result[0]["status"] == "ok"
    assert {call[0] for call in api.calls} == {"GET"}


@pytest.mark.parametrize("adopt", [False, True])
def test_lossy_import_cannot_hide_writable_difference(adopt):
    api = FakeApi()
    budget_id = api.add(declaration(notification_emails=["example@example.invalid"]))
    actions = api.budgets[budget_id]["alert_configurations"][0]["action_configurations"]
    actions.append(dict(actions[0]))
    desired = prepared(declaration(budget_id=budget_id, adopt=adopt,
                                   notification_emails=["example@example.invalid"]))
    steps = lib.build_plan(client(api), desired, [] if adopt else [budget_id])
    assert steps[0]["action"] == ("adopt" if adopt else "update")
    assert lib.apply_plan(client(api), steps, apply=True)[0]["status"] == "ok"
    assert len([call for call in api.calls if call[0] == "PUT"]) == 1


def test_missing_registry_id_is_visible_and_never_mutates():
    api = FakeApi()
    steps = lib.build_plan(client(api), [], ["example-missing"])
    assert len(steps) == 1
    assert steps[0]["action"] == "error"
    assert "not visible" in lib.plan_rows(steps)[0]["details"]
    lib.apply_plan(client(api), steps, apply=True, allow_deletes=True)
    assert {call[0] for call in api.calls} == {"GET"}


@pytest.mark.parametrize("valid_state", [True, False])
def test_notebook_run_all_pauses_then_consumes_and_clears_callback(monkeypatch, valid_state):
    import databricks.sdk

    class NotebookExit(Exception):
        pass

    class Widgets:
        def __init__(self):
            self.values = {"account_id": "example-account"}

        def text(self, name, default):
            self.values.setdefault(name, default)

        def dropdown(self, name, default, choices):
            self.text(name, default)

        def get(self, name):
            return self.values[name]

        def remove(self, name):
            self.values.pop(name, None)

    def exit_notebook(message):
        raise NotebookExit(message)

    widgets = Widgets()
    pending = consent()
    account_factory = Mock(return_value=SimpleNamespace(account_id="example-account"))
    monkeypatch.setenv("DATABRICKS_RUNTIME_VERSION", "example-runtime")
    monkeypatch.setattr(databricks.sdk, "WorkspaceClient", lambda: SimpleNamespace(get_workspace_id=lambda: 101))
    monkeypatch.setattr(lib, "initiate_account_signin", Mock(return_value=pending))
    monkeypatch.setattr(lib, "account_client", account_factory)
    monkeypatch.setitem(sys.modules, "budgets_lib", lib)
    source = (Path(__file__).parents[1] / "src" / "manage_budgets.py").read_text()
    namespace = {"dbutils": SimpleNamespace(widgets=widgets, notebook=SimpleNamespace(exit=exit_notebook)),
                 "displayHTML": Mock()}
    with pytest.raises(NotebookExit, match="Waiting for account sign-in"):
        exec(compile(source, "manage_budgets.py", "exec"), namespace)
    assert namespace["account_consent"] is pending
    pending.exchange.assert_not_called()
    account_factory.assert_not_called()
    widgets.values["account_signin_redirect"] = (
        "example-code" if valid_state else "http://localhost:8020?code=example-code&state=wrong-state"
    )
    exchange_cell = next(cell for cell in source.split("# COMMAND ----------")
                         if 'if AUTH_MODE == "interactive" and (' in cell)
    if valid_state:
        exec(compile(exchange_cell, "signin_cell", "exec"), namespace)
        pending.exchange.assert_called_once_with("example-code", "example-state")
        assert account_factory.call_args.kwargs["session_credentials"] is pending.exchange.return_value
    else:
        with pytest.raises(NotebookExit, match="Re-run the sign-in cell"):
            exec(compile(exchange_cell, "signin_cell", "exec"), namespace)
        pending.exchange.assert_not_called()
        account_factory.assert_not_called()
    assert namespace["account_consent"] is None
    assert "account_signin_redirect" not in widgets.values


def test_apply_rechecks_raw_body_not_lossy_import(monkeypatch):
    api = FakeApi()
    budget_id = api.add(declaration(notification_emails=["example@example.invalid"]))
    actions = api.budgets[budget_id]["alert_configurations"][0]["action_configurations"]
    actions.append(dict(actions[0]))
    desired = prepared(declaration(budget_id=budget_id, notification_emails=["example@example.invalid"]))[0]
    steps = [{"action": "adopt", "budget_id": budget_id, "name": desired["name"],
              "desired": lib.desired_body(desired), "before": api.budgets[budget_id], "message": ""}]
    assert lib.apply_plan(client(api), steps, apply=True)[0]["status"] == "ok"
    assert any(call[0] == "PUT" for call in api.calls)


def test_real_sdk_config_uses_session_not_workspace_environment(monkeypatch):
    import databricks.sdk

    captured = {}

    def account(config):
        captured["config"] = config
        return SimpleNamespace(api_client=FakeApi())

    monkeypatch.setattr(databricks.sdk, "AccountClient", account)
    monkeypatch.setenv("DATABRICKS_HOST", "https://example.invalid")
    monkeypatch.setenv("DATABRICKS_TOKEN", "example-workspace-token")
    session = SimpleNamespace(token=Mock(return_value=SimpleNamespace(access_token="example-account-token")))
    result = lib.account_client(in_runtime=True, account_id="example-account", session_credentials=session)
    assert result.account_id == "example-account"
    assert captured["config"].auth_type == "budget-interactive"
    assert captured["config"].authenticate() == {"Authorization": "Bearer example-account-token"}


def test_missing_pending_consent():
    with pytest.raises(ValueError, match="sign-in cell"):
        lib.exchange_account_signin(None, "example-code")


def test_principal_override_decimal_format_is_not_a_write_difference():
    desired = lib.desired_body(prepared(declaration())[0])
    desired["alert_configurations"][0]["principal_overrides"] = [{"override_threshold": "1"}]
    import copy

    current = copy.deepcopy(desired)
    current["alert_configurations"][0]["principal_overrides"][0]["override_threshold"] = "1.0"
    assert lib.comparable_write_body(current) == lib.comparable_write_body(desired)

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
import manage_budgets as cli
from test_budgets_lib import FakeApi, declaration


@pytest.fixture
def setup_cli(monkeypatch):
    api = FakeApi()
    account = SimpleNamespace(api_client=api, config=SimpleNamespace(
        host="https://accounts.cloud.databricks.com", account_id="example-account"))
    factory = Mock(return_value=account)
    monkeypatch.setattr(cli, "AccountClient", factory)
    workspace = Mock()
    workspace.get_workspace_id.return_value = 101
    monkeypatch.setattr(cli, "WorkspaceClient", Mock(return_value=workspace))
    monkeypatch.setattr(cli, "BUDGETS", [declaration(name="team")])
    monkeypatch.setattr(cli, "MANAGED_BUDGET_IDS", [])
    return api, account, factory, workspace


def run(*args):
    return cli.main(["--account-profile", "chosen", "--workspace-profile", "workspace", *args])


def test_default_plan_is_read_only(setup_cli):
    api, _, factory, _ = setup_cli
    assert run() == 0
    assert all(call[0] == "GET" for call in api.calls)
    factory.assert_called_once_with(profile="chosen")


def test_apply_required_to_create(setup_cli):
    api, *_ = setup_cli
    assert run("--apply") == 0
    assert len([call for call in api.calls if call[0] == "POST"]) == 1


@pytest.mark.parametrize("flags,deleted", [([], False), (["--allow-deletes"], False),
                                          (["--apply"], False), (["--apply", "--allow-deletes"], True)])
def test_delete_requires_both_flags(setup_cli, monkeypatch, flags, deleted):
    api, *_ = setup_cli
    budget_id = api.add(declaration(name="team"))
    monkeypatch.setattr(cli, "BUDGETS", [])
    monkeypatch.setattr(cli, "MANAGED_BUDGET_IDS", [budget_id])
    assert run(*flags) == 0
    assert (budget_id not in api.budgets) == deleted


@pytest.mark.parametrize("host,account_id", [("https://workspace.cloud.databricks.com", "acct"),
                                           ("https://accounts.cloud.databricks.com", "")])
def test_bad_account_profile_has_login_command(setup_cli, capsys, host, account_id):
    _, account, *_ = setup_cli
    account.config.host, account.config.account_id = host, account_id
    assert run() != 0
    assert "databricks auth login --host https://accounts.cloud.databricks.com --account-id" in capsys.readouterr().err


def test_auth_errors_suppress_credentials(setup_cli, capsys):
    setup_cli[2].side_effect = RuntimeError("private-token")
    assert run() != 0
    output = capsys.readouterr().err
    assert "databricks auth login" in output and "private-token" not in output


def test_report_requires_warehouse(setup_cli, capsys):
    assert run("--report") != 0
    assert "--warehouse-id" in capsys.readouterr().err
    setup_cli[2].assert_not_called()


@pytest.mark.parametrize("status", ["failed", "unconfirmed"])
def test_failed_apply_exits_nonzero(setup_cli, monkeypatch, status):
    monkeypatch.setattr(cli.lib, "apply_plan", lambda *args, **kwargs: [{"status": status}])
    assert run("--apply") != 0


def test_example_refused_on_apply(setup_cli, monkeypatch):
    monkeypatch.setattr(cli, "BUDGETS", [declaration()])
    assert run("--apply") != 0
    assert all(call[0] == "GET" for call in setup_cli[0].calls)


def test_plan_error_refused_on_apply(setup_cli, monkeypatch):
    monkeypatch.setattr(cli, "MANAGED_BUDGET_IDS", ["missing"])
    assert run("--apply") != 0
    assert all(call[0] == "GET" for call in setup_cli[0].calls)


def test_required_account_profile():
    with pytest.raises(SystemExit) as error:
        cli.main([])
    assert error.value.code == 2


def test_workspace_override(setup_cli):
    assert cli.main(["--account-profile", "chosen", "--workspace-id", "101"]) == 0
    cli.WorkspaceClient.assert_not_called()


def test_validation_error_before_account_auth(setup_cli, monkeypatch):
    monkeypatch.setattr(cli, "BUDGETS", [declaration(amount="-1")])
    assert run() != 0
    setup_cli[2].assert_not_called()


def test_plan_auth_failure_has_login_command(setup_cli, capsys):
    setup_cli[0].do = Mock(side_effect=RuntimeError("private-token"))
    assert run() != 0
    output = capsys.readouterr().err
    assert "databricks auth login" in output and "private-token" not in output


def test_import_is_opt_in(setup_cli, monkeypatch):
    export = Mock(return_value="BUDGETS = []")
    monkeypatch.setattr(cli.lib, "export_budgets", export)
    assert run() == 0
    export.assert_not_called()
    assert run("--import") == 0
    export.assert_called_once()


def statement(state, rows=None, next_chunk=None, truncated=False):
    from databricks.sdk.service.sql import (
        ColumnInfo,
        ResultData,
        ResultManifest,
        ResultSchema,
        StatementResponse,
        StatementStatus,
    )
    return StatementResponse(
        statement_id="statement", status=StatementStatus(state=state),
        manifest=ResultManifest(schema=ResultSchema(columns=[ColumnInfo(name="cost")]), truncated=truncated),
        result=ResultData(data_array=rows or [], next_chunk_index=next_chunk),
    )


def test_report_polls_prints_all_chunks_and_binds_parameters(setup_cli, monkeypatch, capsys):
    from databricks.sdk.service.sql import ResultData, StatementState

    execution = setup_cli[3].statement_execution
    execution.execute_statement.return_value = statement(StatementState.PENDING)
    execution.get_statement.return_value = statement(StatementState.SUCCEEDED, [["12"]], 1)
    execution.get_statement_result_chunk_n.return_value = ResultData(data_array=[["34"]])
    monkeypatch.setattr(cli.time, "sleep", lambda _: None)
    assert run("--report", "--warehouse-id", "warehouse", "--start-date", "2026-01-01", "--end-date", "2026-02-01") == 0
    options = execution.execute_statement.call_args.kwargs
    assert options["warehouse_id"] == "warehouse"
    parameters = {item.name: item.value for item in options["parameters"]}
    assert parameters["start_date"] == "2026-01-01"
    assert parameters["end_date"] == "2026-02-01"
    assert parameters["account_id"] == "example-account"
    assert parameters["workspace_0"] == "101"
    assert ":account_id" in options["statement"]
    execution.get_statement_result_chunk_n.assert_called_once_with("statement", 1)
    output = capsys.readouterr().out
    assert "cost" in output and "12" in output and "34" in output
    assert all(call[0] == "GET" for call in setup_cli[0].calls)


@pytest.mark.parametrize("failure", ["failed", "truncated", "exception", "timeout"])
def test_report_failures_are_nonzero(setup_cli, monkeypatch, capsys, failure):
    from databricks.sdk.service.sql import StatementState

    execution = setup_cli[3].statement_execution
    execution.execute_statement.return_value = statement(StatementState.FAILED)
    if failure == "truncated":
        execution.execute_statement.return_value = statement(StatementState.SUCCEEDED, truncated=True)
    elif failure == "exception":
        execution.execute_statement.side_effect = RuntimeError("private-token")
    elif failure == "timeout":
        execution.execute_statement.return_value = statement(StatementState.RUNNING)
        monkeypatch.setattr(cli.time, "monotonic", Mock(side_effect=[0, 301]))
    assert run("--report", "--warehouse-id", "warehouse") != 0
    assert "private-token" not in capsys.readouterr().err


def test_report_requires_workspace_profile(setup_cli):
    assert cli.main(["--account-profile", "chosen", "--workspace-id", "101", "--report", "--warehouse-id", "wh"]) != 0


@pytest.mark.parametrize("start,end", [("bad", "2026-02-01"), ("2026-02-01", "2026-01-01")])
def test_report_dates_validated_before_apply(setup_cli, start, end):
    assert run("--apply", "--report", "--warehouse-id", "wh", "--start-date", start, "--end-date", end) != 0
    assert not setup_cli[0].calls

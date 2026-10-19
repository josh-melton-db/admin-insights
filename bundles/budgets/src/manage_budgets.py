"""Plan account budgets locally; mutations require --apply."""

BUDGETS = [
    {
        "name": "example-team-monthly",
        "amount": "100",
        "time_period": "MONTH",
        "quantity_type": "LIST_PRICE_DOLLARS_USD",
        "notification_emails": [],
        "tags": {"project": ["example-project"]},
    },
]
MANAGED_BUDGET_IDS: list[str] = []

import argparse
import datetime as dt
import shlex
import sys
import time

import budgets_lib as lib
from databricks.sdk import AccountClient, WorkspaceClient
from databricks.sdk.service.sql import StatementParameterListItem, StatementState


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--account-profile", required=True, help="Account CLI login profile (not a workspace profile)")
    result.add_argument("--workspace-profile", help="Workspace CLI profile for default scope and reporting")
    result.add_argument("--workspace-id", type=int, help="Override the default workspace scope ID")
    result.add_argument("--apply", action="store_true", help="Apply the plan (default: read-only)")
    result.add_argument("--allow-deletes", action="store_true", help="Permit registered deletions with --apply")
    result.add_argument("--import", dest="import_budgets", action="store_true", help="Print live declarations after planning/apply")
    result.add_argument("--report", action="store_true", help="Print estimated list spend via a SQL warehouse")
    result.add_argument("--warehouse-id", help="SQL warehouse for --report")
    result.add_argument("--start-date", default=(dt.date.today() - dt.timedelta(days=30)).isoformat(), help="Inclusive ISO date (default: 30 days ago)")
    result.add_argument("--end-date", default=dt.date.today().isoformat(), help="Exclusive ISO date (default: today)")
    return result


def login_message(profile):
    return ("Account profile unavailable, invalid, or unauthorized. Sign in with: "
            "databricks auth login --host https://accounts.cloud.databricks.com "
            f"--account-id <ACCOUNT_ID> --profile {shlex.quote(profile)} "
            "(use your cloud's accounts host if different)")


def print_table(columns, rows):
    text_rows = [["NULL" if value is None else str(value) for value in row] for row in rows]
    widths = [max(len(name), *(len(row[index]) for row in text_rows)) if text_rows else len(name)
              for index, name in enumerate(columns)]
    print(" | ".join(name.ljust(width) for name, width in zip(columns, widths)))
    print("-+-".join("-" * width for width in widths))
    for row in text_rows:
        print(" | ".join(value.ljust(width) for value, width in zip(row, widths)))


def report(workspace, warehouse_id, declared, start_date, end_date, account_id):
    print("USD estimated list cost; full monthly thresholds; partial months and missing prices are flagged.")
    for index, budget in enumerate(declared, 1):
        for alert_index in range(len(budget.get("alerts", [None]))):
            print(f"Budget #{index}, alert #{alert_index + 1}")
            query, parameters = lib.report_query(budget, start_date, end_date, account_id, alert_index)
            execution = workspace.statement_execution
            response = execution.execute_statement(
                warehouse_id=warehouse_id, statement=query, wait_timeout="50s",
                parameters=[StatementParameterListItem(name=key, value=str(value))
                            for key, value in parameters.items()],
            )
            deadline = time.monotonic() + 300
            while response.status and response.status.state in (StatementState.PENDING, StatementState.RUNNING):
                if time.monotonic() >= deadline:
                    raise lib.BudgetError("Report timed out; inspect the warehouse query history")
                time.sleep(1)
                response = execution.get_statement(response.statement_id)
            if not response.status or response.status.state != StatementState.SUCCEEDED:
                raise lib.BudgetError("Report failed; verify warehouse access and billing-table SELECT privileges")
            if not response.manifest or response.manifest.truncated:
                raise lib.BudgetError("Report returned missing or truncated results")
            columns = [column.name for column in response.manifest.schema.columns]
            chunk = response.result
            rows = []
            while chunk:
                rows.extend(chunk.data_array or [])
                if chunk.next_chunk_index is None:
                    break
                chunk = execution.get_statement_result_chunk_n(response.statement_id, chunk.next_chunk_index)
            print_table(columns, rows)


def main(argv=None):
    args = parser().parse_args(argv)
    if args.report and not args.warehouse_id:
        print("--report requires --warehouse-id", file=sys.stderr)
        return 1
    if args.report and not args.workspace_profile:
        print("--report requires --workspace-profile", file=sys.stderr)
        return 1
    try:
        workspace = None
        workspace_id = args.workspace_id
        if args.workspace_profile:
            workspace = WorkspaceClient(profile=args.workspace_profile)
            if workspace_id is None:
                workspace_id = int(workspace.get_workspace_id())
        declared, errors = lib.prepare(BUDGETS, workspace_id=workspace_id)
        if (not isinstance(MANAGED_BUDGET_IDS, list) or
                any(not isinstance(budget_id, str) or not lib.ID_RE.fullmatch(budget_id)
                    for budget_id in MANAGED_BUDGET_IDS) or
                len(MANAGED_BUDGET_IDS) != len(set(MANAGED_BUDGET_IDS))):
            errors.append("MANAGED_BUDGET_IDS must be a list of unique budget IDs")
        if args.report:
            start, end = dt.date.fromisoformat(args.start_date), dt.date.fromisoformat(args.end_date)
            if start >= end:
                errors.append("Report end date must follow start date")
        if errors:
            for error in errors:
                print(error, file=sys.stderr)
            return 1
        try:
            account = AccountClient(profile=args.account_profile)
            lib.validate_account_config(account.config)
            client = lib.Client(account, account.config.account_id)
            steps = lib.build_plan(client, declared, MANAGED_BUDGET_IDS)
        except Exception:
            print(login_message(args.account_profile), file=sys.stderr)
            return 1
        print(f"Validated {len(declared)} budgets.")
        for row in lib.plan_rows(steps):
            print(row)
        if args.apply:
            if any(budget["name"].startswith("example-") for budget in declared):
                raise lib.BudgetError("Replace shipped example-* declarations before applying")
            if any(step["action"] == "error" for step in steps):
                raise lib.BudgetError("Resolve every plan error before applying")
            results = lib.apply_plan(client, steps, apply=True, allow_deletes=args.allow_deletes)
            for result in results:
                print(result)
            if any(result["status"] in ("failed", "unconfirmed") for result in results):
                raise lib.BudgetError("Apply failed/unconfirmed; import before retrying, never repeat creates blindly")
        else:
            print("Dry run: no budget mutations. Deletes require --apply and --allow-deletes.")
        if args.import_budgets:
            print(lib.export_budgets(client))
        if args.report:
            report(workspace, args.warehouse_id, declared, args.start_date, args.end_date, client.account_id)
        return 0
    except lib.BudgetError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Operation failed; verify workspace profile, scope, report dates and permissions (details suppressed)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

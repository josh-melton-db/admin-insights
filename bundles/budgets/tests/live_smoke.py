"""Opt-in live gates. Default is GET-only; --throwaway authorizes one isolated budget."""

import argparse
import ast
import collections
import hashlib
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
import budgets_lib as lib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--throwaway", action="store_true")
    args = parser.parse_args()
    if os.environ.get("DATABRICKS_ACCOUNT_PROFILE") != "budget-account-test":
        raise ValueError("This smoke requires the explicitly authorized account profile")
    from databricks.sdk import WorkspaceClient

    workspace = WorkspaceClient(profile="DEFAULT")
    workspace_id = int(workspace.get_workspace_id())
    assert workspace_id > 0
    from databricks.sdk import AccountClient

    account = AccountClient(profile="budget-account-test")
    lib.validate_account_config(account.config)
    client = lib.Client(account, account.config.account_id)
    statuses = collections.Counter()
    phase = ["read_only"]

    def record(response, *unused, **kwargs):
        statuses[(phase[0], response.request.method, response.status_code)] += 1
        if response.status_code >= 400 and phase[0] != "verify_deleted":
            try:
                body = response.json()
                message = str(body.get("message", ""))
                for private in (client.account_id, str(workspace_id)):
                    message = message.replace(private, "[masked-id]")
                message = re.sub(r"[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{27,}", "[masked-id]", message)
                message = re.sub(r"\b\d{5,}\b", "[masked-id]", message)
                message = re.sub(r"[^\s@]+@[^\s@]+", "[masked-email]", message)
                message = re.sub(r"https?://[^\s]+", "[masked-host]", message)
                message = re.sub(r"(?i)Bearer\s+\S+|dapi[A-Za-z0-9]+", "[masked-token]", message)
                print(json.dumps({"phase": phase[0], "http_status": response.status_code,
                                  "error_code": body.get("error_code"), "message": message}))
            except (ValueError, TypeError, AttributeError):
                print(json.dumps({"phase": phase[0], "http_status": response.status_code, "message": "non-JSON error suppressed"}))

    client.api._api_client._session.hooks["response"].append(record)
    original_do = client.api.do
    name = "zz-foreman-throwaway-" + uuid.uuid4().hex
    state = {"post_attempts": 0, "created_id": None, "put_attempts": 0}
    wire_attempts = collections.Counter()
    original_request = client.api._api_client._session.request

    def guarded_request(method, url, **kwargs):
        if method in ("POST", "PUT") and urlparse(url).path.startswith(client.base):
            assert wire_attempts[method] == 0
            wire_attempts[method] += 1
        return original_request(method, url, **kwargs)

    client.api._api_client._session.request = guarded_request

    def guarded(method, path, **kwargs):
        if method != "GET":
            if not args.throwaway:
                raise AssertionError("Read-only smoke refused a mutation")
            if method == "POST":
                assert path == client.base and state["post_attempts"] == 0
                assert kwargs["body"]["budget"]["display_name"] == name
                state["post_attempts"] += 1
            else:
                assert method in ("PUT", "DELETE") and state["created_id"]
                assert path == client.base + "/" + state["created_id"]
                if method == "PUT":
                    assert state["put_attempts"] == 0
                    state["put_attempts"] += 1
        response = original_do(method, path, **kwargs)
        if method == "POST":
            state["created_id"] = response["budget"]["budget_configuration_id"]
        return response

    client.api.do = guarded
    before = client.list()
    before_ids = {budget["budget_configuration_id"] for budget in before}
    declared, errors = lib.prepare([{"name": "example-read-only-plan", "amount": "100", "notification_emails": []}], workspace_id=workspace_id)
    assert not errors
    steps = lib.build_plan(client, declared, [])
    assert lib.apply_plan(client, steps, apply=False) == []
    exported = lib.export_budgets(client)
    imported = ast.literal_eval(exported.split("BUDGETS = ", 1)[1])
    roundtrip, errors = lib.prepare(imported, workspace_id=workspace_id)
    assert not errors
    owned = [budget["budget_id"] for budget in roundtrip]
    assert all(step["action"] == "no-op" for step in lib.build_plan(client, roundtrip, owned))
    print(json.dumps({"phase": "read_only", "live_count": len(before), "plan_steps": len(steps),
                      "imported_count": len(imported), "unsupported_or_unreadable": len(before) - len(imported)}))

    workspace.api_client._api_client._session.hooks["response"].append(record)
    for table in ("system.billing.usage", "system.billing.list_prices"):
        try:
            workspace.api_client.do("GET", "/api/2.1/unity-catalog/tables/" + table)
            print(json.dumps({"phase": "billing_table_metadata", "table": table, "accessible": True}))
        except Exception:
            print(json.dumps({"phase": "billing_table_metadata", "table": table, "accessible": False}))
    print("Report SQL not executed: local SQL statement submission is POST; workspace smoke remains GET-only.")

    if args.throwaway:
        entry = {"name": name, "amount": "1", "notification_emails": [], "scope": "workspace", "workspace_id": workspace_id,
                 "tags": {"foreman_throwaway_isolation": [uuid.uuid4().hex]}}
        try:
            phase[0] = "create"
            desired, errors = lib.prepare([entry], workspace_id=workspace_id)
            assert not errors
            create_plan = lib.build_plan(client, desired, [])
            assert [step["action"] for step in create_plan] == ["create"]
            created = lib.apply_plan(client, create_plan, apply=True)
            assert created[0]["status"] == "ok"
            budget_id = state["created_id"]
            assert budget_id not in before_ids
            live = client.get(budget_id)
            assert live["display_name"] == name
            assert lib.declaration_from_live(live)["workspace_id"] == workspace_id
            assert live["filter"]["workspace_id"]["values"] == [workspace_id]
            phase[0] = "update"
            desired, errors = lib.prepare([{**entry, "budget_id": budget_id, "amount": "2"}], workspace_id=workspace_id)
            assert not errors
            update_plan = lib.build_plan(client, desired, [budget_id])
            assert [step["action"] for step in update_plan] == ["update"]
            updated = lib.apply_plan(client, update_plan, apply=True)
            assert updated[0]["status"] == "ok"
            assert lib.declaration_from_live(client.get(budget_id))["amount"] == "2"
        finally:
            phase[0] = "cleanup"
            if not state["created_id"]:
                recovered = [budget["budget_configuration_id"] for budget in client.list()
                             if budget.get("display_name") == name and budget["budget_configuration_id"] not in before_ids]
                assert len(recovered) <= 1
                state["created_id"] = recovered[0] if recovered else None
            budget_id = state["created_id"]
            if budget_id:
                assert budget_id not in before_ids
                for attempt in range(3):
                    existing = [budget for budget in client.list() if budget["budget_configuration_id"] == budget_id]
                    if not existing:
                        break
                    assert existing[0]["display_name"] == name
                    delete_plan = lib.build_plan(client, [], [budget_id])
                    assert len(delete_plan) == 1 and delete_plan[0]["action"] == "delete"
                    deleted = lib.apply_plan(client, delete_plan, apply=True, allow_deletes=True)
                    if deleted[0]["status"] == "ok":
                        break
                    time.sleep(attempt + 1)
                phase[0] = "verify_deleted"
                if any(budget["budget_configuration_id"] == budget_id for budget in client.list()):
                    print(json.dumps({"phase": "cleanup", "confirmed": False,
                                      "id_fingerprint": hashlib.sha256(budget_id.encode()).hexdigest()[:12]}))
                    raise AssertionError("Cleanup not confirmed")
                try:
                    client.get(budget_id)
                except lib.BudgetError:
                    assert statuses[("verify_deleted", "GET", 404)] >= 1
                else:
                    raise AssertionError("Deleted budget is still returned by GET")
                print(json.dumps({"phase": "cleanup", "left_behind": 0, "preexisting_budgets_mutated": 0}))
            else:
                print(json.dumps({"phase": "cleanup", "left_behind": 0, "created": False}))
            for (step, method, status), count in sorted(statuses.items()):
                print(json.dumps({"phase": step, "method": method, "http_status": status, "count": count}))
    else:
        for (step, method, status), count in sorted(statuses.items()):
            print(json.dumps({"phase": step, "method": method, "http_status": status, "count": count}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"smoke": "failed", "exception_type": type(error).__name__, "details": "suppressed"}))
        raise SystemExit(1) from None

"""Account budgets as code: pure declarations, explicit ownership, thin REST client."""

import copy
import datetime as dt
import os
import pprint
import re
import time
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse


ACCOUNT_HOSTS = {
    "accounts.cloud.databricks.com",
    "accounts.azuredatabricks.net",
    "accounts.gcp.databricks.com",
}
TIME_PERIOD = "MONTH"
QUANTITY_TYPE = "LIST_PRICE_DOLLARS_USD"
TRIGGER_TYPE = "CUMULATIVE_SPENDING_EXCEEDED"
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
FIELDS = {"name", "budget_id", "adopt", "amount", "notification_emails", "workspace_ids", "tags",
          "time_period", "quantity_type", "trigger_type", "scope", "workspace_id", "resource_type",
          "product_type", "pricing_basis", "include_external_spend", "alerts"}
ALL_RESOURCES = "BUDGET_RESOURCE_TYPE_ALL_RESOURCES"
AI_RESOURCES = "BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY"
ALL_PRODUCTS = "BUDGET_PRODUCT_TYPE_ALL_PRODUCTS"
AI_PRODUCTS = "BUDGET_PRODUCT_TYPE_UNITY_AI_GATEWAY"
LIST_PRICE = "BUDGET_PRICING_BASIS_LIST_PRICE"
SHARED = "ALERT_CONFIGURATION_SCOPE_TYPE_SHARED"
PER_USER = "ALERT_CONFIGURATION_SCOPE_TYPE_PER_USER"


class BudgetError(RuntimeError):
    """Sanitized API or unsupported-schema failure."""


def _amount(value):
    number = Decimal(str(value))
    if not number.is_finite() or number <= 0:
        raise ValueError
    text = format(number, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _alerts(raw, label, errors):
    normalized = []
    if not isinstance(raw, list) or not raw:
        errors.append(f"{label}: alerts must be a nonempty list")
        return normalized
    for index, alert in enumerate(raw, 1):
        prefix = f"{label} alert #{index}"
        if not isinstance(alert, dict):
            errors.append(f"{prefix}: must be a dict")
            continue
        allowed = {"quantity_threshold", "time_period", "quantity_type", "trigger_type", "scope_type",
                   "action_configurations", "principal_overrides", "alert_configuration_id"}
        if set(alert) - allowed:
            errors.append(f"{prefix}: unknown alert fields")
        result = copy.deepcopy(alert)
        try:
            result["quantity_threshold"] = _amount(alert.get("quantity_threshold"))
        except (InvalidOperation, ValueError, TypeError):
            errors.append(f"{prefix}: invalid quantity_threshold")
        for key, default in (("time_period", TIME_PERIOD), ("quantity_type", QUANTITY_TYPE),
                             ("trigger_type", TRIGGER_TYPE), ("scope_type", SHARED)):
            result.setdefault(key, default)
            allowed_values = (SHARED, PER_USER) if key == "scope_type" else (default,)
            if result[key] not in allowed_values:
                errors.append(f"{prefix}: unsupported {key}")
        if "alert_configuration_id" in alert and (not isinstance(alert["alert_configuration_id"], str) or
                                                  not ID_RE.fullmatch(alert["alert_configuration_id"])):
            errors.append(f"{prefix}: invalid alert_configuration_id")
        actions = alert.get("action_configurations", [])
        if not isinstance(actions, list):
            errors.append(f"{prefix}: action_configurations must be a list")
            actions = []
        result["action_configurations"] = []
        for action in actions:
            if not isinstance(action, dict) or set(action) - {"action_configuration_id", "action_type", "target", "notify_affected_user"}:
                errors.append(f"{prefix}: unsupported action fields")
                continue
            item = copy.deepcopy(action)
            item.setdefault("notify_affected_user", False)
            if (item.get("action_type") not in ("EMAIL_NOTIFICATION", "BLOCK_USAGE") or type(item["notify_affected_user"]) is not bool or
                    (item.get("action_type") == "EMAIL_NOTIFICATION" and not item["notify_affected_user"] and
                     (not isinstance(item.get("target"), str) or not EMAIL_RE.fullmatch(item["target"])))):
                errors.append(f"{prefix}: invalid email action")
            if "action_configuration_id" in item and (not isinstance(item["action_configuration_id"], str) or
                                                      not ID_RE.fullmatch(item["action_configuration_id"])):
                errors.append(f"{prefix}: invalid action_configuration_id")
            result["action_configurations"].append(item)
        overrides = alert.get("principal_overrides", [])
        if not isinstance(overrides, list) or (overrides and result["scope_type"] != PER_USER):
            errors.append(f"{prefix}: principal_overrides requires a per-user alert and a list")
            overrides = []
        result["principal_overrides"] = []
        principals = set()
        for override in overrides:
            if not isinstance(override, dict) or set(override) != {"principal_id", "override_threshold"}:
                errors.append(f"{prefix}: invalid principal override fields")
                continue
            principal = override["principal_id"]
            if type(principal) is not int or not 0 < principal < 2**63 or principal in principals:
                errors.append(f"{prefix}: invalid or duplicate principal_id")
            else:
                principals.add(principal)
            try:
                threshold = _amount(override["override_threshold"])
                result["principal_overrides"].append({"principal_id": principal, "override_threshold": threshold})
            except (InvalidOperation, ValueError, TypeError):
                errors.append(f"{prefix}: invalid override_threshold")
        normalized.append(result)
    return normalized


def prepare(entries, workspace_id=None):
    """Collect all declaration errors without echoing potentially private values."""
    if not isinstance(entries, list):
        return [], ["BUDGETS must be a list"]
    budgets, errors, names, ids = [], [], set(), set()
    for index, entry in enumerate(entries, 1):
        label = f"budget #{index}"
        before = len(errors)
        if not isinstance(entry, dict):
            errors.append(f"{label}: must be a dict")
            continue
        advanced = None
        if "alerts" in entry:
            if any(key in entry for key in ("amount", "notification_emails", "time_period", "quantity_type", "trigger_type")):
                errors.append(f"{label}: use alerts or simple threshold fields, not both")
            advanced = _alerts(entry["alerts"], label, errors)
            entry = {**entry, "amount": "1", "notification_emails": []}
        scope = entry.get("scope", "workspace")
        scoped_workspace = entry.get("workspace_id", workspace_id if scope == "workspace" else None)
        if scope not in ("workspace", "account"):
            errors.append(f"{label}: scope must be workspace or account")
        if scope == "workspace" and (type(scoped_workspace) is not int or not 0 < scoped_workspace < 2**63):
            errors.append(f"{label}: workspace scope requires a positive runtime workspace_id")
        if scope == "account" and scoped_workspace is not None:
            errors.append(f"{label}: account scope cannot specify workspace_id")
        resource_type = entry.get("resource_type", ALL_RESOURCES)
        product_type = entry.get("product_type", AI_PRODUCTS if resource_type == AI_RESOURCES else ALL_PRODUCTS)
        if resource_type not in (ALL_RESOURCES, AI_RESOURCES) or product_type not in (ALL_PRODUCTS, AI_PRODUCTS):
            errors.append(f"{label}: unsupported resource_type or product_type")
        if (resource_type == AI_RESOURCES) != (product_type == AI_PRODUCTS):
            errors.append(f"{label}: resource_type and product_type must agree")
        if entry.get("pricing_basis", LIST_PRICE) != LIST_PRICE:
            errors.append(f"{label}: unsupported pricing_basis")
        if entry.get("include_external_spend", False) is not False:
            errors.append(f"{label}: external spend is not supported by the documented write schema")
        if set(entry) - FIELDS:
            errors.append(f"{label}: unknown field(s)")
        for key in ("name", "amount", "notification_emails"):
            if key not in entry:
                errors.append(f"{label}: missing {key}")
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 128:
            errors.append(f"{label}: name must be 1-128 nonblank characters")
        elif name in names:
            errors.append(f"{label}: duplicate name")
        else:
            names.add(name)
        budget_id = entry.get("budget_id")
        if budget_id is not None:
            if not isinstance(budget_id, str) or not ID_RE.fullmatch(budget_id):
                errors.append(f"{label}: invalid budget_id")
            elif budget_id in ids:
                errors.append(f"{label}: duplicate budget_id")
            else:
                ids.add(budget_id)
        adopt = entry.get("adopt", False)
        if not isinstance(adopt, bool) or (adopt and not budget_id):
            errors.append(f"{label}: adopt must be boolean and requires budget_id")
        try:
            amount = _amount(entry.get("amount"))
        except (InvalidOperation, ValueError, TypeError):
            errors.append(f"{label}: amount must be a finite positive number")
            amount = "1"
        for key, expected in (("time_period", TIME_PERIOD), ("quantity_type", QUANTITY_TYPE),
                              ("trigger_type", TRIGGER_TYPE)):
            if entry.get(key, expected) != expected:
                errors.append(f"{label}: unsupported {key}")
        emails = entry.get("notification_emails", [])
        if not isinstance(emails, list) or any(not isinstance(email, str) or not EMAIL_RE.fullmatch(email) for email in emails):
            errors.append(f"{label}: notification_emails must be a list of email addresses")
        workspace_ids = entry.get("workspace_ids", [scoped_workspace] if scope == "workspace" else None)
        if workspace_ids is not None and (not isinstance(workspace_ids, list) or not workspace_ids or any(
                type(workspace_id) is not int or workspace_id <= 0 or workspace_id > 2**63 - 1 for workspace_id in workspace_ids)):
            errors.append(f"{label}: workspace_ids must be a nonempty list of positive int64 IDs")
        elif scope == "workspace" and workspace_ids != [scoped_workspace]:
            errors.append(f"{label}: workspace filter must match the resource workspace_id")
        tags = entry.get("tags", {})
        if not isinstance(tags, dict) or any(
                not isinstance(key, str) or not key or not isinstance(values, list) or not values or
                any(not isinstance(value, str) for value in values) for key, values in tags.items()):
            errors.append(f"{label}: tags must map nonempty keys to nonempty lists of strings")
        if len(errors) == before:
            budgets.append({
                "name": name, "budget_id": budget_id, "adopt": adopt,
                "amount": amount, "notification_emails": sorted(set(emails)),
                "workspace_ids": sorted(set(workspace_ids)) if workspace_ids is not None else None,
                "tags": {key: sorted(set(values)) for key, values in sorted(tags.items())},
                "time_period": TIME_PERIOD, "quantity_type": QUANTITY_TYPE, "trigger_type": TRIGGER_TYPE,
                "scope": scope, "workspace_id": scoped_workspace, "resource_type": resource_type,
                "product_type": product_type, "pricing_basis": LIST_PRICE,
                "include_external_spend": entry.get("include_external_spend", False),
            })
            if advanced is not None:
                for key in ("amount", "notification_emails", "time_period", "quantity_type", "trigger_type"):
                    budgets[-1].pop(key)
                budgets[-1]["alerts"] = advanced
    return budgets, errors


def desired_body(budget):
    filters = {}
    if budget["workspace_ids"] is not None:
        filters["workspace_id"] = {"operator": "IN", "values": budget["workspace_ids"]}
    if budget["tags"]:
        filters["tags"] = [{"key": key, "value": {"operator": "IN", "values": values}}
                           for key, values in budget["tags"].items()]
    body = {
        "display_name": budget["name"], "filter": filters,
        "resource_type": budget["resource_type"], "product_type": budget["product_type"],
        "pricing_basis": budget["pricing_basis"], "include_external_spend": budget["include_external_spend"],
    }
    if budget["scope"] == "workspace":
        body["workspace_id"] = budget["workspace_id"]
    if "alerts" in budget:
        body["alert_configurations"] = copy.deepcopy(budget["alerts"])
    else:
        body["alert_configurations"] = [{
            "time_period": budget["time_period"], "quantity_type": budget["quantity_type"],
            "trigger_type": budget["trigger_type"], "quantity_threshold": budget["amount"],
            "scope_type": SHARED, "principal_overrides": [],
            "action_configurations": [{"action_type": "EMAIL_NOTIFICATION", "target": email, "notify_affected_user": False}
                                      for email in budget["notification_emails"]],
        }]
    return body


def semantic_body(body):
    normalized = copy.deepcopy(body)
    normalized.pop("workspace_id", None)
    for alert in normalized["alert_configurations"]:
        alert.pop("alert_configuration_id", None)
        for action in alert.get("action_configurations", []):
            action.pop("action_configuration_id", None)
    return normalized


def write_body(body):
    return {key: copy.deepcopy(value) for key, value in body.items()
            if key in {"display_name", "filter", "alert_configurations", "resource_type"}}


def validate_account_config(config):
    parsed = urlparse(config.host or "")
    if (parsed.scheme != "https" or parsed.hostname not in ACCOUNT_HOSTS or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("An HTTPS account-host credential is required; workspace credentials are not supported")
    if not config.account_id or not ID_RE.fullmatch(config.account_id):
        raise ValueError("Set account_id or configure it in the explicitly selected account profile")
    return config


def account_client(*, in_runtime=False, account_id="", secret_scope="", secret_key="",
                   account_host="https://accounts.cloud.databricks.com", dbutils=None):
    """Same account Config/secret path as budget_api_auth; never use WorkspaceClient auth."""
    from databricks.sdk import AccountClient
    from databricks.sdk.core import Config

    options = {"http_timeout_seconds": 30, "retry_timeout_seconds": 60}
    if in_runtime:
        if not all((account_id, secret_scope, secret_key, dbutils)):
            raise ValueError("Runtime requires account_id and account-token secret scope/key")
        validate_account_config(type("AccountConfig", (), {"host": account_host, "account_id": account_id})())
        try:
            token = dbutils.secrets.get(scope=secret_scope, key=secret_key)
            config = Config(host=account_host, account_id=account_id, token=token, auth_type="pat", **options)
        except Exception:
            raise BudgetError("Could not load runtime account credential") from None
    else:
        profile = os.environ.get("DATABRICKS_ACCOUNT_PROFILE", "").strip()
        if not profile:
            raise ValueError("Set DATABRICKS_ACCOUNT_PROFILE to an explicit account-level CLI profile")
        try:
            config = Config(profile=profile, **({"account_id": account_id} if account_id else {}), **options)
        except Exception:
            raise BudgetError("Could not load the selected account profile") from None
    validate_account_config(config)
    try:
        return Client(AccountClient(config=config), config.account_id)
    except Exception:
        raise BudgetError("Could not initialize account client") from None


class Client:
    def __init__(self, account, account_id):
        if not isinstance(account_id, str) or not ID_RE.fullmatch(account_id):
            raise ValueError("Invalid account_id")
        self.api = account.api_client
        self.account_id = account_id
        self.base = f"/api/2.1/accounts/{account_id}/budgets"

    def _do(self, method, suffix="", **kwargs):
        try:
            response = self.api.do(method, self.base + suffix, **kwargs)
        except Exception:
            raise BudgetError(f"Budgets API {method} failed; response details suppressed") from None
        if response is None:
            return {}
        if not isinstance(response, dict):
            raise BudgetError("Unexpected budgets response schema")
        return response

    def list(self):
        budgets, seen, query = [], set(), {}
        for _ in range(1000):
            response = self._do("GET", query=query)
            page = response.get("budgets", [])
            if not isinstance(page, list) or any(not isinstance(budget, dict) for budget in page):
                raise BudgetError("Unexpected budgets list schema")
            budgets.extend(page)
            token = response.get("next_page_token")
            if not token:
                return budgets
            if not isinstance(token, str) or token in seen:
                raise BudgetError("Budgets pagination did not advance")
            seen.add(token)
            query = {"page_token": token}
        raise BudgetError("Budgets pagination exceeded safety bound")

    def get(self, budget_id):
        response = self._do("GET", self._suffix(budget_id))
        budget = response.get("budget")
        if not isinstance(budget, dict) or budget.get("budget_configuration_id") != budget_id:
            raise BudgetError("Unexpected get-budget schema")
        return budget

    @staticmethod
    def _suffix(budget_id):
        if not isinstance(budget_id, str) or not ID_RE.fullmatch(budget_id):
            raise ValueError("Invalid budget_id")
        return "/" + budget_id

    def create(self, body):
        return self._do("POST", body={"budget": {**write_body(body), "account_id": self.account_id}})

    def update(self, budget_id, body):
        return self._do("PUT", self._suffix(budget_id), body={"budget": {
            **write_body(body), "account_id": self.account_id, "budget_configuration_id": budget_id}})

    def delete(self, budget_id):
        return self._do("DELETE", self._suffix(budget_id))


def _only(value, allowed):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise BudgetError("Unsupported budget fields; refusing lossy import or replacement")


def declaration_from_live(live):
    """Round-trip supported workspace/account resource scopes and all observed alert types."""
    _only(live, {"account_id", "budget_configuration_id", "create_time", "update_time", "display_name", "filter", "alert_configurations",
                 "name", "workspace_id", "backfilled_usage_start_time", "streaming_ingestion_start_time",
                 "pricing_basis", "product_type", "resource_type", "include_external_spend"})
    alerts = live.get("alert_configurations") or []
    clean_alerts = []
    for alert in alerts:
        _only(alert, {"alert_configuration_id", "time_period", "quantity_type", "trigger_type", "quantity_threshold", "action_configurations", "scope_type", "principal_overrides", "create_time", "update_time"})
        clean = {key: copy.deepcopy(value) for key, value in alert.items() if key not in ("create_time", "update_time")}
        actions = []
        for action in alert.get("action_configurations") or []:
            _only(action, {"action_configuration_id", "action_type", "target", "create_time", "update_time", "notify_affected_user"})
            actions.append({key: value for key, value in action.items() if key not in ("create_time", "update_time")})
        clean["action_configurations"] = actions
        clean_alerts.append(clean)
    filters = live.get("filter") or {}
    _only(filters, {"workspace_id", "tags"})
    workspace_ids = None
    if filters.get("workspace_id"):
        clause = filters["workspace_id"]
        _only(clause, {"operator", "values"})
        if clause.get("operator") != "IN":
            raise BudgetError("Unsupported workspace filter operator")
        workspace_ids = clause.get("values")
    tags = {}
    for clause in filters.get("tags") or []:
        _only(clause, {"key", "value"})
        value = clause.get("value")
        _only(value, {"operator", "values"})
        if value.get("operator") != "IN" or clause.get("key") in tags:
            raise BudgetError("Unsupported or duplicate tag filter")
        tags[clause.get("key")] = value.get("values")
    scoped_workspace = live.get("workspace_id")
    if scoped_workspace in (None, 0, "0"):
        scoped_workspace = workspace_ids[0] if isinstance(workspace_ids, list) and len(workspace_ids) == 1 else None
    resource_type = live.get("resource_type", ALL_RESOURCES)
    entry = {
        "name": live.get("display_name"), "budget_id": live.get("budget_configuration_id"), "adopt": False,
        "scope": "workspace" if scoped_workspace else "account", "workspace_id": scoped_workspace,
        "resource_type": resource_type,
        "product_type": live.get("product_type", AI_PRODUCTS if resource_type == AI_RESOURCES else ALL_PRODUCTS),
        "pricing_basis": live.get("pricing_basis", LIST_PRICE),
        "include_external_spend": live.get("include_external_spend", False),
        "workspace_ids": workspace_ids, "tags": tags, "alerts": clean_alerts,
    }
    if scoped_workspace and workspace_ids is None:
        entry.pop("workspace_ids")
    entries, errors = prepare([entry])
    if errors:
        raise BudgetError("Live budget cannot be represented safely")
    normalized = entries[0]
    clean_alerts = normalized["alerts"]
    if (len(clean_alerts) == 1 and clean_alerts[0]["scope_type"] == SHARED and not clean_alerts[0]["principal_overrides"] and
            all(action["action_type"] == "EMAIL_NOTIFICATION" and not action["notify_affected_user"] for action in clean_alerts[0]["action_configurations"])):
        alert = clean_alerts[0]
        normalized.pop("alerts")
        normalized.update(amount=alert["quantity_threshold"], time_period=alert["time_period"], quantity_type=alert["quantity_type"],
                          trigger_type=alert["trigger_type"], notification_emails=sorted({action["target"] for action in alert["action_configurations"]}))
    return normalized


def build_plan(client, declared, managed_budget_ids):
    if not isinstance(managed_budget_ids, list) or any(not isinstance(budget_id, str) or not ID_RE.fullmatch(budget_id) for budget_id in managed_budget_ids):
        raise ValueError("MANAGED_BUDGET_IDS must be a list of budget IDs")
    live = client.list()
    by_id = {budget.get("budget_configuration_id"): budget for budget in live}
    if None in by_id or len(by_id) != len(live):
        raise BudgetError("Ambiguous live budget IDs")
    steps, desired_ids = [], {budget["budget_id"] for budget in declared if budget["budget_id"]}
    for budget in declared:
        budget_id = budget["budget_id"]
        step = {"name": budget["name"], "budget_id": budget_id, "desired": desired_body(budget), "action": "error", "message": "", "before": None}
        if budget_id:
            if budget_id not in by_id:
                step["message"] = "Declared budget ID is not visible; refusing replacement create"
            elif budget_id not in managed_budget_ids and not budget["adopt"]:
                step["message"] = "Unmanaged ID: set adopt=True explicitly or add to MANAGED_BUDGET_IDS"
            else:
                try:
                    current = client.get(budget_id)
                    normalized = semantic_body(desired_body(declaration_from_live(current)))
                    desired = semantic_body(step["desired"])
                    step["before"] = current
                    step["action"] = ("adopt" if budget_id not in managed_budget_ids else
                                      "no-op" if normalized == desired else "update")
                    changed = [key for key in normalized.keys() | desired.keys() if normalized.get(key) != desired.get(key)]
                    step["message"] = "Changed fields: " + ", ".join(changed) if changed else "Desired fields match"
                except (BudgetError, TypeError, KeyError, ValueError):
                    step["message"] = "Could not safely read or represent target; no mutation allowed"
        elif any(existing.get("display_name") == budget["name"] for existing in live):
            step["message"] = "Name already exists: import and explicitly adopt by ID"
        else:
            step["action"] = "create"
            step["message"] = "Create new budget; record the returned ID for future management"
        steps.append(step)
    for budget_id in sorted(set(managed_budget_ids) - desired_ids):
        if budget_id in by_id:
            current = client.get(budget_id)
            steps.append({"name": current.get("display_name", ""), "budget_id": budget_id, "action": "delete",
                          "before": current, "message": "Explicitly owned ID removed from BUDGETS; requires both gates"})
    return steps


def plan_rows(steps):
    return [{"budget": index, "action": step["action"], "details": step["message"]}
            for index, step in enumerate(steps, 1)]


def _verify(client, budget_id, desired=None, deleted=False, sleep=time.sleep):
    for attempt in range(4):
        if deleted:
            if all(budget.get("budget_configuration_id") != budget_id for budget in client.list()):
                return True
        else:
            try:
                if semantic_body(desired_body(declaration_from_live(client.get(budget_id)))) == semantic_body(desired):
                    return True
            except (BudgetError, TypeError, KeyError, ValueError):
                pass
        if attempt < 3:
            sleep(0.5 * (attempt + 1))
    return False


def apply_plan(client, steps, *, apply=False, allow_deletes=False, sleep=time.sleep):
    """Never write by default; stale snapshots fail closed. No automatic create retries."""
    if apply is not True:
        return []
    results = []
    for step in steps:
        action, budget_id = step["action"], step["budget_id"]
        result = {"action": action, "budget_id": budget_id, "status": "skipped", "message": ""}
        results.append(result)
        if action in ("error", "no-op"):
            result["message"] = step["message"]
            continue
        if action == "delete" and allow_deletes is not True:
            result["message"] = "allow_deletes=false"
            continue
        try:
            if action == "create":
                if any(budget.get("display_name") == step["name"] for budget in client.list()):
                    raise BudgetError("Name collision since plan; re-plan")
                response = client.create(step["desired"])
                budget_id = (response.get("budget") or {}).get("budget_configuration_id")
                result["budget_id"] = budget_id
                if not budget_id:
                    raise BudgetError("Create outcome unknown; import before retrying")
            elif action in ("update", "adopt", "delete"):
                if client.get(budget_id) != step["before"]:
                    raise BudgetError("Target changed since plan; re-plan")
                if action == "delete":
                    client.delete(budget_id)
                else:
                    client.update(budget_id, step["desired"])
            else:
                raise BudgetError("Unknown plan action")
            confirmed = _verify(client, budget_id, step.get("desired"), deleted=action == "delete", sleep=sleep)
            result["status"] = "ok" if confirmed else "unconfirmed"
            result["message"] = "Verified by GET" if confirmed else "Not confirmed; re-import before retrying"
        except (BudgetError, ValueError, KeyError, TypeError):
            result["status"] = "failed"
            result["message"] = "Step failed or target changed; re-import before retrying (details suppressed)"
    return results


def export_budgets(client):
    entries, skipped = [], 0
    for budget in client.list():
        try:
            entry = declaration_from_live(client.get(budget["budget_configuration_id"]))
            entries.append(entry)
        except (BudgetError, KeyError, ValueError, TypeError):
            skipped += 1
    prefix = f"# skipped {skipped} unsupported or unreadable budgets\n" if skipped else ""
    return prefix + "BUDGETS = " + pprint.pformat(entries, sort_dicts=False, width=100)


def report_query(budget, start_date, end_date, account_id, alert_index=0):
    """Parameterized Spark SQL; [start, end), monthly full thresholds, USD list estimate."""
    start, end = dt.date.fromisoformat(start_date), dt.date.fromisoformat(end_date)
    if start >= end:
        raise ValueError("Report end_date must be after start_date (exclusive)")
    if budget["resource_type"] != ALL_RESOURCES or budget["include_external_spend"]:
        raise ValueError("Exact resource-specific/external spend is unavailable from the billing-table join")
    if "alerts" in budget:
        alert = budget["alerts"][alert_index]
        if alert["scope_type"] == PER_USER:
            raise ValueError("Exact per-user attribution/principal overrides are unavailable from billing usage")
        amount = alert["quantity_threshold"]
    else:
        amount = budget["amount"]
    parameters = {"start_date": start.isoformat(), "end_date": end.isoformat(), "account_id": account_id,
                  "budget_amount": amount}
    filters = ["u.account_id = :account_id", "u.usage_date >= CAST(:start_date AS DATE)",
               "u.usage_date < CAST(:end_date AS DATE)"]
    if budget["workspace_ids"] is not None:
        placeholders = []
        for index, workspace_id in enumerate(budget["workspace_ids"]):
            key = f"workspace_{index}"
            parameters[key] = str(workspace_id)
            placeholders.append(":" + key)
        filters.append("u.workspace_id IN (" + ", ".join(placeholders) + ")")
    for index, (tag, values) in enumerate(budget["tags"].items()):
        key = f"tag_key_{index}"
        parameters[key] = tag
        placeholders = []
        for value_index, value in enumerate(values):
            value_key = f"tag_value_{index}_{value_index}"
            parameters[value_key] = value
            placeholders.append(":" + value_key)
        filters.append(f"element_at(u.custom_tags, :{key}) IN (" + ", ".join(placeholders) + ")")
    where = "\n      AND ".join(filters)
    return f"""WITH monthly AS (
    SELECT date_trunc('MONTH', u.usage_date) AS budget_month,
           SUM(u.usage_quantity * p.pricing.effective_list.default) AS estimated_list_cost_usd,
           COUNT_IF(p.pricing.effective_list.default IS NULL) AS unpriced_rows
    FROM system.billing.usage u
    LEFT JOIN system.billing.list_prices p
      ON p.sku_name = u.sku_name AND p.cloud = u.cloud AND p.usage_unit = u.usage_unit
     AND p.currency_code = 'USD'
     AND u.usage_end_time >= p.price_start_time
     AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
    WHERE {where}
    GROUP BY date_trunc('MONTH', u.usage_date)
)
SELECT *, CAST(:budget_amount AS DECIMAL(38, 6)) AS monthly_budget_usd,
       estimated_list_cost_usd / CAST(:budget_amount AS DECIMAL(38, 6)) * 100 AS percent_of_budget,
       estimated_list_cost_usd - CAST(:budget_amount AS DECIMAL(38, 6)) AS over_budget_usd,
       CAST(:start_date AS DATE) > CAST(budget_month AS DATE)
         OR CAST(:end_date AS DATE) < add_months(CAST(budget_month AS DATE), 1) AS partial_month
FROM monthly ORDER BY budget_month""", parameters

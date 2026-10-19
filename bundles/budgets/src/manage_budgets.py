# Databricks notebook source
# MAGIC %md
# MAGIC # Account budgets as code
# MAGIC Edit declarations, then run all. `apply=false` is GET-only for budget calls.
# MAGIC Account-host credentials are required; workspace credentials are used only for reporting.
# MAGIC See README.md before adopting or deleting a budget. Import output contains private configuration.

# COMMAND ----------

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

# COMMAND ----------

import datetime as dt

dbutils.widgets.dropdown("apply", "false", ["false", "true"])
dbutils.widgets.dropdown("allow_deletes", "false", ["false", "true"])
dbutils.widgets.text("account_id", "")
dbutils.widgets.text("account_host", "https://accounts.cloud.databricks.com")
dbutils.widgets.dropdown("account_auth", "interactive", ["interactive", "secret"])
dbutils.widgets.text("account_signin_redirect", "")
dbutils.widgets.text("account_token_secret_scope", "")
dbutils.widgets.text("account_token_secret_key", "")
dbutils.widgets.text("report_start_date", (dt.date.today() - dt.timedelta(days=30)).isoformat())
dbutils.widgets.text("report_end_date", dt.date.today().isoformat())
APPLY = dbutils.widgets.get("apply") == "true"
ALLOW_DELETES = dbutils.widgets.get("allow_deletes") == "true"

# COMMAND ----------

import os
import sys
from databricks.sdk import WorkspaceClient

sys.path.insert(0, os.getcwd())
import budgets_lib as lib

IN_RUNTIME = bool(os.environ.get("DATABRICKS_RUNTIME_VERSION"))
workspace = WorkspaceClient() if IN_RUNTIME else WorkspaceClient(profile="DEFAULT")
try:
    WORKSPACE_ID = int(workspace.get_workspace_id())
except Exception:
    raise RuntimeError("Could not discover current workspace ID; verify the workspace credential/context") from None
declared, errors = lib.prepare(BUDGETS, workspace_id=WORKSPACE_ID)
if not isinstance(MANAGED_BUDGET_IDS, list) or any(
    not isinstance(budget_id, str) or not lib.ID_RE.fullmatch(budget_id)
    for budget_id in MANAGED_BUDGET_IDS
):
    errors.append("MANAGED_BUDGET_IDS must be a list of budget IDs")
try:
    start_date = dt.date.fromisoformat(dbutils.widgets.get("report_start_date"))
    end_date = dt.date.fromisoformat(dbutils.widgets.get("report_end_date"))
    if start_date >= end_date:
        raise ValueError
except ValueError:
    errors.append("Report dates must be YYYY-MM-DD with start before exclusive end")
if errors:
    raise ValueError("Invalid declarations:\n" + "\n".join(f"  - {error}" for error in errors))
AUTH_MODE = lib.account_auth_mode(IN_RUNTIME, dbutils.widgets.get("account_auth"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Account sign-in
# MAGIC Run this cell to start/restart sign-in. Open the link and complete sign-in yourself.
# MAGIC The browser will land on an expected **failed localhost page**; do not retry that page.
# MAGIC Paste its full address (preferred, verifies returned state) or just its code into
# MAGIC `account_signin_redirect`, then **run the next cell**, not this cell or Run all.
# MAGIC Do not paste into notebook source or outputs. The widget is cleared on consumption;
# MAGIC widget inputs may be retained by the platform, so never share the notebook while signing in.
# MAGIC A code-only paste uses the pending consent state and PKCE; it cannot check returned state.

# COMMAND ----------

from html import escape

client = None
account_consent = None
if AUTH_MODE == "interactive":
    dbutils.widgets.text("account_signin_redirect", "")
    account_consent = lib.initiate_account_signin(
        dbutils.widgets.get("account_host").strip(), dbutils.widgets.get("account_id").strip()
    )
    displayHTML('<a target="_blank" rel="noopener noreferrer" href="' +
                escape(account_consent.authorization_url, quote=True) + '">Sign in to the account</a>')
    print("After sign-in, paste the failed localhost page's address into account_signin_redirect and run the next cell.")

# COMMAND ----------

if AUTH_MODE == "interactive" and (account_consent is None or not dbutils.widgets.get("account_signin_redirect").strip()):
    dbutils.notebook.exit("Waiting for account sign-in: re-run the sign-in cell if needed, open the link, paste the redirected URL or code, then run this cell and continue.")
try:
    client = lib.account_client(
        in_runtime=IN_RUNTIME,
        account_auth=AUTH_MODE,
        account_id=dbutils.widgets.get("account_id").strip(),
        account_host=dbutils.widgets.get("account_host").strip(),
        secret_scope=dbutils.widgets.get("account_token_secret_scope").strip(),
        secret_key=dbutils.widgets.get("account_token_secret_key").strip(),
        dbutils=dbutils,
        session_credentials=(lib.exchange_account_signin(account_consent, dbutils.widgets.get("account_signin_redirect"))
                             if AUTH_MODE == "interactive" else None),
    )
except (ValueError, lib.BudgetError):
    dbutils.notebook.exit("Account authentication failed (possibly stale/reused code or state mismatch). Re-run the sign-in cell and sign in again; secret/local mode users should verify their explicit credential configuration.")
finally:
    account_consent = None
    dbutils.widgets.remove("account_signin_redirect")
if client is None:
    raise RuntimeError("Complete account authentication before continuing")
print(f"Validated {len(declared)} budgets. Account credential configured; values suppressed.")

# COMMAND ----------

steps = lib.build_plan(client, declared, MANAGED_BUDGET_IDS)
for row in lib.plan_rows(steps):
    print(row)
if any(step["action"] == "error" for step in steps):
    print("Plan contains errors. Those targets cannot be changed; import and explicitly adopt by ID.")

# COMMAND ----------

if APPLY:
    if any(budget["name"].startswith("example-") for budget in declared):
        raise ValueError("Replace shipped example-* declarations before applying")
    if any(step["action"] == "error" for step in steps):
        raise ValueError("Resolve every plan error before applying")
    results = lib.apply_plan(client, steps, apply=True, allow_deletes=ALLOW_DELETES)
    for result in results:
        print({key: value for key, value in result.items() if key != "budget_id"})
    created_ids = [result["budget_id"] for result in results if result["action"] == "create" and result["budget_id"]]
    print(f"Created {len(created_ids)} budgets. Copy their IDs from the import cell into declarations and ownership list.")
    if any(result["status"] in ("failed", "unconfirmed") for result in results):
        raise RuntimeError("Some outcomes are failed/unconfirmed. Re-import before retrying; do not repeat creates blindly.")
else:
    print("apply=false: no budget mutations. Deletes additionally require allow_deletes=true.")

# COMMAND ----------

print(lib.export_budgets(client))

# COMMAND ----------

print("USD estimated list cost; monthly thresholds are not prorated. Partial months and missing prices are flagged.")
for index, budget in enumerate(declared, 1):
    for alert_index in range(len(budget.get("alerts", [None]))):
        print(f"Budget #{index}, alert #{alert_index + 1}")
        try:
            query, parameters = lib.report_query(
                budget, dbutils.widgets.get("report_start_date"), dbutils.widgets.get("report_end_date"),
                client.account_id, alert_index=alert_index
            )
        except ValueError as error:
            print(f"Report limitation: {error}")
            continue
        try:
            display(spark.sql(query, args=parameters))
        except Exception:
            raise RuntimeError("Report failed: verify billing-table SELECT privileges and compatible Spark runtime; details suppressed") from None

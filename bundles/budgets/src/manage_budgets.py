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
dbutils.widgets.text("account_token_secret_scope", "")
dbutils.widgets.text("account_token_secret_key", "")
dbutils.widgets.text("report_start_date", (dt.date.today() - dt.timedelta(days=30)).isoformat())
dbutils.widgets.text("report_end_date", dt.date.today().isoformat())
APPLY = dbutils.widgets.get("apply") == "true"
ALLOW_DELETES = dbutils.widgets.get("allow_deletes") == "true"

# COMMAND ----------

import os
import sys

sys.path.insert(0, os.getcwd())
import budgets_lib as lib

declared, errors = lib.prepare(BUDGETS)
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
client = lib.account_client(
    in_runtime=bool(os.environ.get("DATABRICKS_RUNTIME_VERSION")),
    account_id=dbutils.widgets.get("account_id").strip(),
    account_host=dbutils.widgets.get("account_host").strip(),
    secret_scope=dbutils.widgets.get("account_token_secret_scope").strip(),
    secret_key=dbutils.widgets.get("account_token_secret_key").strip(),
    dbutils=dbutils,
)
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
    query, parameters = lib.report_query(
        budget, dbutils.widgets.get("report_start_date"), dbutils.widgets.get("report_end_date"), client.account_id
    )
    print(f"Budget #{index}")
    try:
        display(spark.sql(query, args=parameters))
    except Exception:
        raise RuntimeError("Report failed: verify billing-table SELECT privileges and compatible Spark runtime; details suppressed") from None

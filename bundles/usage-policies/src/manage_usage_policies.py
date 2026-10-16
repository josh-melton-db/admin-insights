# Databricks notebook source
# MAGIC %md
# MAGIC # Serverless usage policies as code
# MAGIC
# MAGIC Declare policies in the next cell, then run all. With `apply=false` (the default) the notebook only
# MAGIC validates, plans, prints importable policies, and reports chargeback. Set `apply=true` to execute the plan.
# MAGIC Deletes also need `allow_deletes=true`. See `README.md` for the safety rules and permissions.

# COMMAND ----------

# 1. Declare. Every policy needs the required tag keys. The marker tag
# managed_by=usage-policies-notebook is added automatically; do not declare it.
#   workspace_ids: omit for the current workspace, "all" for every workspace, or a list of IDs.
#   users / managers: "users/<email>", "groups/<account group>", "servicePrincipals/<applicationId>".
REQUIRED_TAG_KEYS = ["cost_center", "project", "owner"]

POLICIES = [
    {
        "name": "example-data-eng-project",
        "tags": {"cost_center": "CC-0000-EXAMPLE", "project": "example-ingest", "owner": "example-team"},
        "users": [],
        "managers": [],
    },
    {
        "name": "example-ml-research",
        "tags": {"cost_center": "CC-9999-EXAMPLE", "project": "example-forecasting", "owner": "example-ml-team"},
        "users": [],
        "managers": [],
    },
]

# COMMAND ----------

# 2. Widgets.
import datetime as dt

dbutils.widgets.dropdown("apply", "false", ["false", "true"])
dbutils.widgets.dropdown("allow_deletes", "false", ["false", "true"])
dbutils.widgets.text("chargeback_start_date", (dt.date.today() - dt.timedelta(days=30)).isoformat())
dbutils.widgets.text("chargeback_end_date", dt.date.today().isoformat())
dbutils.widgets.text("currency_code", "USD")
dbutils.widgets.text("account_id", "")

APPLY = dbutils.widgets.get("apply") == "true"
ALLOW_DELETES = dbutils.widgets.get("allow_deletes") == "true"

# COMMAND ----------

# 3. Validate. The lib sits next to this notebook; workspace files in the same folder are importable.
import os
import sys
import uuid

import pandas as pd
from databricks.sdk import WorkspaceClient

sys.path.insert(0, os.getcwd())
import usage_policies_lib as lib

w = WorkspaceClient()
WORKSPACE_ID = w.get_workspace_id()
ACCOUNT_ID = lib.discover_account_id(w, dbutils.widgets.get("account_id"))
CALLER = lib.caller_principal(w)
client = lib.Client(w, ACCOUNT_ID)
try:
    RUN_TOKEN  # keep the same token when a cell is retried, so creates replay the same request_id
except NameError:
    RUN_TOKEN = str(uuid.uuid4())

declared, errors = lib.prepare(POLICIES, WORKSPACE_ID, REQUIRED_TAG_KEYS)
if errors:
    raise ValueError("Invalid POLICIES:\n" + "\n".join(f"  - {e}" for e in errors))
print(f"{len(declared)} declared policies are valid. Caller: {CALLER}")

# COMMAND ----------

# 4. Plan.
steps = lib.build_plan(client, declared, CALLER, ALLOW_DELETES)
print("The caller's Manager grant is never removed by this notebook.")
display(pd.DataFrame(lib.plan_rows(steps), columns=["policy", "action", "policy_id", "details"]))

# COMMAND ----------

# 5. Apply (only when apply=true).
if APPLY:
    results = lib.apply_plan(client, steps, RUN_TOKEN, CALLER, ALLOW_DELETES)
    display(pd.DataFrame(results, columns=["policy", "action", "policy_id", "status", "message"]))
    display(pd.DataFrame(lib.managed_state(client), columns=["policy", "policy_id", "tags", "workspaces"]))
    failed = [r for r in results if r["status"] in ("failed", "unconfirmed")]
    if failed:
        raise RuntimeError(f"{len(failed)} apply step(s) failed or are unconfirmed; the rest succeeded (see above).")
    RUN_TOKEN = str(uuid.uuid4())  # all done: the next apply in this session gets fresh request_ids
else:
    print("apply=false: plan only. Set the apply widget to true to execute it.")

# COMMAND ----------

# 6. Import. Paste this into cell 1 to adopt existing policies (apply adds the managed marker).
print(lib.export_policies(client, WORKSPACE_ID))

# COMMAND ----------

# 7. Chargeback: spend by policy, by required tag, and by day (list-price estimate in one currency).
# Every table keeps usage_unit, so quantities in different units (DBU, GPU hours, ...) are never summed together.
from pyspark.sql import functions as F

start, end = lib.chargeback_dates(dbutils.widgets.get("chargeback_start_date"),
                                  dbutils.widgets.get("chargeback_end_date"))
args = {"start_date": start, "end_date": end, "currency_code": lib.currency_code(dbutils.widgets.get("currency_code"))}
names = spark.createDataFrame([(p["policy_id"], p["policy_name"]) for p in client.list_policies()],
                              "policy_id string, policy_name string")
print(f"Chargeback {start} .. {end}, list prices in {args['currency_code']}")

by_policy = spark.sql(lib.chargeback_sql("policy"), args=args).join(names, "policy_id", "left")
display(by_policy.withColumn("policy_name", F.coalesce("policy_name", F.lit("(not visible to caller)")))
        .select("policy_id", "policy_name", "usage_unit", "currency_code", "usage_quantity", "est_list_cost")
        .orderBy(F.desc_nulls_last("est_list_cost")))

# COMMAND ----------

for key in REQUIRED_TAG_KEYS:
    display(spark.sql(lib.chargeback_sql("tag"), args={**args, "tag_key": key}).withColumnRenamed("tag_value", key))

# COMMAND ----------

display(spark.sql(lib.chargeback_sql("day"), args=args))

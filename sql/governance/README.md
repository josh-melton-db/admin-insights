# Admin Insights governed reporting assets

Run these files on the selected serverless SQL warehouse in numeric order.
Analytics queries in `config/queries/*.obo.sql` execute as the signed-in user
and read the daily materialized views rather than scanning `system.access.audit`
live. Raw audit scans commonly take 30–120 seconds and abort AppKit SSE streams.

1. `01_schema.sql` — create `demos.admin_insights`.
2. `02_activity_daily_mvs.sql` — rolling 90-day daily facts for logins, object
   access, schema creation, and native request-for-access events.
3. `03_admin_insights_metrics.sql` — certified metric view over the access facts.
4. After the first app deploy, replace the placeholder in
   `04_app_service_principal_grants.template.sql` with the app service principal
   client ID (`9e4c4663-646a-4845-8c98-444d75dca35b` for this workspace). Grant
   information_schema SELECT only, plus `demos.admin_insights` so install-time
   typegen can DESCRIBE the reporting MVs.
5. `05_admin_obo_grants.template.sql` is scoped to the `admins` group configured
   in `ADMIN_INSIGHTS_ADMIN_GROUPS`.
6. `06_app_activity_daily_mvs.sql` — rolling 90-day daily facts for Databricks
   Apps user-authorization (OBO) actions and createApp/updateApp `user_api_scopes`.
   App usage in the UI is OBO events plus Insights, not billing on/off.
   Both MVs refresh themselves with `SCHEDULE EVERY 1 DAY`. The
   `apps-monitoring` bundle (`bundles/apps-monitoring/`) does not refresh them;
   it maintains its own prefixed copies (`monitor_app_obo_activity_daily`,
   `monitor_app_config_events_daily`) with the same SELECTs. Keep both in sync.
7. `07_actor_activity_daily_mv.sql` — rolling 90-day daily actors from audit
   (email, run_as, run_by) by service. Overview user counts read this MV, not
   `system.query.history`.
8. `08_genie_activity_daily_mv.sql` — rolling 90-day Genie Agent (`aibiGenie`)
   interactions by actor, space, and action. Genie return panels read this MV.
9. `09_ai_return_activity_daily_mv.sql` — rolling 90-day Vector Search
   `queryVectorIndex` / `createVectorIndex` facts. Knowledge Assistant questions
   are index queries on `ka_{id}_*` indexes. Serving endpoint queries still come
   from `system.serving.endpoint_usage`, not this MV.

`system.access.audit` is not a Delta source, so incremental MV refresh is not
eligible. These MVs use a bounded rolling 90-day daily full refresh. Do not
change them to an unbounded or hourly full-history refresh.

Sensitive-data and row-count panels need additional grants that this workspace
may not yet have:

```sql
GRANT USE SCHEMA ON SCHEMA system.data_classification TO `admins`;
GRANT SELECT ON TABLE system.data_classification.results TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.data_quality_monitoring TO `admins`;
GRANT SELECT ON TABLE system.data_quality_monitoring.table_results TO `admins`;
```

Until those grants exist, the app shows “not collected” rather than estimating.
Keep raw `system.access.audit` grants for ad-hoc forensics outside the app.

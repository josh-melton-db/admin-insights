-- system.access.audit is not a Delta source, so incremental refresh is not
-- eligible. These views use a bounded rolling 90-day daily full refresh.
-- AppKit queries read these MVs rather than scanning audit live.
-- Run each CREATE as its own warehouse statement.
-- These MVs refresh themselves (SCHEDULE EVERY 1 DAY). The apps-monitoring
-- bundle (bundles/apps-monitoring) does not touch them: it owns separate
-- prefixed copies (e.g. monitor_app_obo_activity_daily) with the same columns.
-- Keep the SELECTs in sync with bundles/apps-monitoring/src/refresh_app_mvs.sql.
-- app_obo_activity_daily keeps only Databricks Apps rows. acting_resource is
-- also set for other OAuth clients (databricks-cli, browserFleet, Slack/Teams,
-- dbt, ...), and identity_metadata.acting_resource_type does not separate them:
-- it is 'Application Service Principal' for databricks-cli too and empty for
-- some Apps rows, so the filter matches the custom-app-integrations path.

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.app_obo_activity_daily
COMMENT 'Daily-refreshing Databricks Apps on-behalf-of (user authorization) facts from the last 90 days of system.access.audit. Grain: activity date, workspace, acting resource, user, service, action. Only Databricks Apps rows: acting_resource is the full path accounts/<account>/oauth2/custom-app-integrations/<oauth2_app_client_id>, and oauth2_app_client_id is its last segment (match it to the Apps API oauth2_app_client_id). Most rows have workspace_id 0, so do not match on workspace. user_email can be the app service principal application ID rather than a human.'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  identity_metadata.acting_resource AS acting_resource,
  user_identity.email AS user_email,
  service_name,
  action_name,
  count(*) AS event_count,
  regexp_extract(identity_metadata.acting_resource, '([^/]+)$', 1) AS oauth2_app_client_id
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND identity_metadata.acting_resource LIKE 'accounts/%/oauth2/custom-app-integrations/%'
GROUP BY
  event_date,
  workspace_id,
  identity_metadata.acting_resource,
  user_identity.email,
  service_name,
  action_name;

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.app_config_events_daily
COMMENT 'Daily-refreshing latest createApp/updateApp payload per app for the last 90 days. Used to flag apps that do not declare user_api_scopes (possible app-SP-only authorization).'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  event_time,
  workspace_id,
  action_name,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) AS actor,
  get_json_object(element_at(request_params, 'app'), '$.name') AS app_name,
  get_json_object(element_at(request_params, 'app'), '$.user_api_scopes') AS user_api_scopes
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND action_name IN ('createApp', 'updateApp')
  AND get_json_object(element_at(request_params, 'app'), '$.name') IS NOT NULL
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY event_date, workspace_id, get_json_object(element_at(request_params, 'app'), '$.name')
  ORDER BY event_time DESC
) = 1;

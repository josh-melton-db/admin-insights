-- system.access.audit is not a Delta source, so incremental refresh is not
-- eligible. Bounded rolling 90-day daily full refresh.
-- AppKit queries read this MV rather than scanning audit live.
-- Run as its own warehouse statement.

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.actor_activity_daily
COMMENT 'Daily-refreshing workspace actors from the last 90 days of system.access.audit. Grain: activity date, workspace, actor, service. Used for active-user counts that are not limited to SQL query history.'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) AS actor,
  service_name,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) IS NOT NULL
GROUP BY
  event_date,
  workspace_id,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by),
  service_name;

-- system.access.audit is not a Delta source. Bounded rolling 90-day daily
-- full refresh. AppKit queries read this MV rather than scanning audit live.
-- Run as its own warehouse statement.

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.genie_activity_daily
COMMENT 'Daily-refreshing Genie Agent (aibiGenie) audit facts from the last 90 days. Grain: activity date, workspace, actor, action, space, HTTP status. Used for Genie interaction (return) counts.'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) AS actor,
  action_name,
  coalesce(
    element_at(request_params, 'space_id'),
    element_at(request_params, 'spaceId')
  ) AS space_id,
  response.status_code AS response_status_code,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND service_name = 'aibiGenie'
GROUP BY
  event_date,
  workspace_id,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by),
  action_name,
  coalesce(
    element_at(request_params, 'space_id'),
    element_at(request_params, 'spaceId')
  ),
  response.status_code;

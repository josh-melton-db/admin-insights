-- system.access.audit is not a Delta source. Bounded rolling 90-day daily
-- full refresh. AppKit queries read this MV rather than scanning audit live.
-- Run as its own warehouse statement.
--
-- queryVectorIndex is the return signal for Vector Search indexes and for
-- Knowledge Assistant questions (KA retrieval uses ka_{prefix}_*_index).
-- createVectorIndex carries endpoint_name so spend can join when the create
-- event is still in the 90-day window.

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.ai_return_activity_daily
COMMENT 'Daily-refreshing Vector Search query and index-create facts from the last 90 days. Grain: activity date, workspace, action, index name, endpoint name. Knowledge Assistant questions are queryVectorIndex rows on ka_{id}_ indexes. Used to tie attributed spend to queries and questions.'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  service_name,
  action_name,
  element_at(request_params, 'name') AS resource_name,
  element_at(request_params, 'endpoint_name') AS endpoint_name,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND service_name = 'vectorSearch'
  AND action_name IN ('queryVectorIndex', 'createVectorIndex')
  AND element_at(request_params, 'name') IS NOT NULL
GROUP BY
  event_date,
  workspace_id,
  service_name,
  action_name,
  element_at(request_params, 'name'),
  element_at(request_params, 'endpoint_name');

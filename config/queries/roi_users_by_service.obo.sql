-- Executes on behalf of the signed-in user.
-- Distinct audit users by Databricks service. Complements query-origin charts.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
SELECT
  coalesce(service_name, 'unknown') AS service_name,
  count(DISTINCT CASE WHEN actor LIKE '%@%' THEN actor END) AS active_users,
  count(DISTINCT actor) AS active_principals,
  coalesce(sum(event_count), 0) AS audit_events
FROM demos.admin_insights.actor_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY coalesce(service_name, 'unknown')
ORDER BY active_users DESC, audit_events DESC
LIMIT :limit;

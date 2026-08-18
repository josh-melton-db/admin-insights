-- Executes on behalf of the signed-in user.
-- Daily active users from the audit actor MV. Do not scan system.access.audit live.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  activity_date,
  count(DISTINCT CASE WHEN actor LIKE '%@%' THEN actor END) AS active_users,
  count(DISTINCT CASE
    WHEN actor RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN actor
  END) AS active_service_principals,
  coalesce(sum(event_count), 0) AS audit_events
FROM demos.admin_insights.actor_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY activity_date
ORDER BY activity_date;

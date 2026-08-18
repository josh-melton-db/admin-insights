-- Executes on behalf of the signed-in user.
-- Reads the governed 90-day daily MV. Do not point this query at system.access.audit.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
SELECT
  activity_date,
  workspace_id,
  actor,
  user_agent,
  action_name,
  event_count
FROM demos.admin_insights.login_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
ORDER BY activity_date DESC, event_count DESC
LIMIT :limit;

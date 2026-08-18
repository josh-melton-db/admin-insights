-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  activity_date,
  sum(event_count) AS login_count,
  count(DISTINCT actor) AS distinct_actors
FROM demos.admin_insights.login_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY activity_date
ORDER BY activity_date;

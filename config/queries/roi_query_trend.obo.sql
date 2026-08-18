-- Daily SQL query counts. distinct_users here is SQL query history only,
-- not workspace audit users. Use roi_user_activity_trend for audit users.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  DATE(start_time) AS query_date,
  count(*) AS query_count,
  count(DISTINCT executed_by) AS distinct_users
FROM system.query.history
WHERE DATE(start_time) >= CAST(:startDate AS DATE)
  AND DATE(start_time) <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY DATE(start_time)
ORDER BY query_date;

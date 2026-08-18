-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
SELECT
  coalesce(client_application, 'unknown') AS client_application,
  count(*) AS query_count,
  count(DISTINCT executed_by) AS distinct_users
FROM system.query.history
WHERE DATE(start_time) >= CAST(:startDate AS DATE)
  AND DATE(start_time) <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY coalesce(client_application, 'unknown')
ORDER BY query_count DESC
LIMIT :limit;

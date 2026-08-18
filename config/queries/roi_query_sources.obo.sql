-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  CASE
    WHEN query_source.genie_space_id IS NOT NULL THEN 'genie'
    WHEN query_source.dashboard_id IS NOT NULL OR query_source.legacy_dashboard_id IS NOT NULL THEN 'dashboard'
    WHEN query_source.notebook_id IS NOT NULL THEN 'notebook'
    WHEN query_source.job_info.job_id IS NOT NULL THEN 'job'
    WHEN query_source.sql_query_id IS NOT NULL THEN 'sql'
    WHEN query_source.alert_id IS NOT NULL THEN 'alert'
    WHEN query_source.pipeline_info.pipeline_id IS NOT NULL THEN 'pipeline'
    ELSE 'other'
  END AS query_origin,
  count(*) AS query_count,
  count(DISTINCT executed_by) AS distinct_users,
  coalesce(sum(read_rows), 0) AS rows_read,
  coalesce(sum(produced_rows), 0) AS rows_returned
FROM system.query.history
WHERE DATE(start_time) >= CAST(:startDate AS DATE)
  AND DATE(start_time) <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY query_origin
ORDER BY query_count DESC;

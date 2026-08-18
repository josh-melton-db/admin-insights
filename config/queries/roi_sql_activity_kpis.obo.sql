-- Executes on behalf of the signed-in user.
-- SQL activity only: queries and rows processed. Not the user count and not
-- estate inventory. system.storage.table_metrics_history has bytes/files, not rows.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  count(*) AS query_count,
  coalesce(sum(read_rows), 0) AS rows_read,
  coalesce(sum(produced_rows), 0) AS rows_returned,
  current_timestamp() AS as_of,
  'system.query.history' AS metric_source
FROM system.query.history
WHERE DATE(start_time) >= CAST(:startDate AS DATE)
  AND DATE(start_time) <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId);

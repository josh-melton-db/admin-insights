-- Executes on behalf of the signed-in user.
-- Active bytes are only available when table metrics have been collected.
-- This query never estimates storage and never runs estate-wide COUNT(*).
-- @param startDate DATE
-- @param endDate DATE
-- @param catalogPattern STRING
-- @param limit INT
SELECT
  snapshot_date,
  catalog_name,
  count(*) AS table_count,
  coalesce(sum(active_bytes), 0) AS active_bytes,
  max(record_generation_time) AS collected_at,
  'system.storage.table_metrics_history' AS metric_source
FROM system.storage.table_metrics_history
WHERE snapshot_date >= CAST(:startDate AS DATE)
  AND snapshot_date <= CAST(:endDate AS DATE)
  AND catalog_name NOT IN ('system', 'samples', '__databricks_internal')
  AND lower(catalog_name) LIKE lower(:catalogPattern)
GROUP BY snapshot_date, catalog_name
ORDER BY snapshot_date DESC, catalog_name
LIMIT :limit;

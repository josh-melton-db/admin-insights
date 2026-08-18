-- Executes on behalf of the signed-in user.
-- Tables most often read as lineage sources — the return side of ROI.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param catalogPattern STRING
-- @param limit INT
SELECT
  l.workspace_id,
  l.source_table_full_name AS table_full_name,
  coalesce(l.source_table_catalog, split_part(l.source_table_full_name, '.', 1)) AS catalog_name,
  coalesce(l.source_table_schema, split_part(l.source_table_full_name, '.', 2)) AS schema_name,
  coalesce(l.source_table_name, split_part(l.source_table_full_name, '.', 3)) AS table_name,
  count(*) AS read_events,
  count(DISTINCT l.entity_id) AS consumer_entities,
  count(DISTINCT CASE WHEN l.entity_type = 'NOTEBOOK' THEN l.entity_id END) AS notebook_consumers,
  count(DISTINCT CASE WHEN l.entity_type IN ('DASHBOARD_V3', 'DASHBOARD') THEN l.entity_id END) AS dashboard_consumers,
  count(DISTINCT CASE WHEN l.entity_type = 'DBSQL_QUERY' THEN l.entity_id END) AS sql_query_consumers,
  count(DISTINCT CASE WHEN l.entity_type = 'JOB' THEN l.entity_id END) AS job_consumers,
  count(DISTINCT CASE WHEN l.entity_type = 'PIPELINE' THEN l.entity_id END) AS pipeline_consumers,
  max(l.event_time) AS last_read_time,
  'system.access.table_lineage' AS metric_source
FROM system.access.table_lineage l
WHERE l.event_date >= CAST(:startDate AS DATE)
  AND l.event_date <= CAST(:endDate AS DATE)
  AND l.source_table_full_name IS NOT NULL
  AND (:workspaceScope = 'all' OR l.workspace_id = :workspaceId)
  AND (
    :catalogPattern = '%'
    OR lower(coalesce(l.source_table_catalog, split_part(l.source_table_full_name, '.', 1))) LIKE lower(:catalogPattern)
  )
  AND lower(coalesce(l.source_table_catalog, split_part(l.source_table_full_name, '.', 1))) NOT IN ('system', 'samples')
  AND lower(coalesce(l.source_table_catalog, split_part(l.source_table_full_name, '.', 1))) NOT LIKE '__databricks_internal%'
GROUP BY
  l.workspace_id,
  l.source_table_full_name,
  coalesce(l.source_table_catalog, split_part(l.source_table_full_name, '.', 1)),
  coalesce(l.source_table_schema, split_part(l.source_table_full_name, '.', 2)),
  coalesce(l.source_table_name, split_part(l.source_table_full_name, '.', 3))
ORDER BY consumer_entities DESC, read_events DESC
LIMIT :limit;

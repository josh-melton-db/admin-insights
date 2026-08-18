-- Executes on behalf of the signed-in user.
-- Tables written by jobs or pipelines in-window that were never read as a lineage
-- source. Mirrors the Cost & Usage Suite unused_datasets query, date-bounded.
-- Does not scan information_schema for the whole estate.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param catalogPattern STRING
-- @param limit INT
WITH produced AS (
  SELECT
    l.workspace_id,
    l.target_table_full_name AS table_full_name,
    l.target_table_catalog AS catalog_name,
    first(l.entity_type, true) AS producer_type,
    first(l.entity_id, true) AS producer_id,
    first(l.created_by, true) AS produced_by,
    max(l.event_time) AS last_write_time
  FROM system.access.table_lineage l
  WHERE l.event_date >= CAST(:startDate AS DATE)
    AND l.event_date <= CAST(:endDate AS DATE)
    AND l.target_table_full_name IS NOT NULL
    AND l.entity_type IN ('JOB', 'PIPELINE')
    AND (:workspaceScope = 'all' OR l.workspace_id = :workspaceId)
    AND (
      :catalogPattern = '%'
      OR lower(coalesce(l.target_table_catalog, '')) LIKE lower(:catalogPattern)
    )
    AND lower(coalesce(l.target_table_catalog, '')) NOT IN ('system', 'samples')
    AND lower(coalesce(l.target_table_catalog, '')) NOT LIKE '__databricks_internal%'
  GROUP BY l.workspace_id, l.target_table_full_name, l.target_table_catalog
),
read_tables AS (
  SELECT DISTINCT source_table_full_name AS table_full_name
  FROM system.access.table_lineage
  WHERE event_date >= CAST(:startDate AS DATE)
    AND event_date <= CAST(:endDate AS DATE)
    AND source_table_full_name IS NOT NULL
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
)
SELECT
  p.workspace_id,
  p.table_full_name,
  p.catalog_name,
  p.producer_type,
  p.producer_id,
  p.produced_by,
  p.last_write_time,
  'produced_never_read' AS unused_reason,
  'system.access.table_lineage' AS metric_source
FROM produced p
LEFT JOIN read_tables r
  ON p.table_full_name = r.table_full_name
WHERE r.table_full_name IS NULL
ORDER BY p.last_write_time DESC
LIMIT :limit;

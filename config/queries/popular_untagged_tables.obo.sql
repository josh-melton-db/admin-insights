-- Executes on behalf of the signed-in user.
-- Most-read tables in the window that have no table-level tag. Governance Hub
-- Tags recommendations: missing tags on popular tables.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param catalogPattern STRING
-- @param limit INT
WITH popular AS (
  SELECT
    l.workspace_id,
    l.source_table_full_name AS table_full_name,
    coalesce(l.source_table_catalog, split_part(l.source_table_full_name, '.', 1)) AS catalog_name,
    coalesce(l.source_table_schema, split_part(l.source_table_full_name, '.', 2)) AS schema_name,
    coalesce(l.source_table_name, split_part(l.source_table_full_name, '.', 3)) AS table_name,
    count(*) AS read_events,
    count(DISTINCT l.entity_id) AS consumer_entities,
    max(l.event_time) AS last_read_time
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
),
tagged AS (
  SELECT DISTINCT catalog_name, schema_name, table_name
  FROM system.information_schema.table_tags
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
)
SELECT
  p.workspace_id,
  p.table_full_name,
  p.catalog_name,
  p.schema_name,
  p.table_name,
  p.read_events,
  p.consumer_entities,
  p.last_read_time
FROM popular p
LEFT JOIN tagged t
  ON p.catalog_name = t.catalog_name
  AND p.schema_name = t.schema_name
  AND p.table_name = t.table_name
WHERE t.table_name IS NULL
ORDER BY p.consumer_entities DESC, p.read_events DESC
LIMIT :limit;

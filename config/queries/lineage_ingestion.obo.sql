-- Executes on behalf of the signed-in user.
-- Lineage event counts by source/target type and catalog. Click through to lineage_connections.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param catalogPattern STRING
-- @param limit INT
SELECT
  coalesce(source_type, '') AS source_type,
  coalesce(target_type, '') AS target_type,
  coalesce(source_table_catalog, '') AS source_table_catalog,
  coalesce(target_table_catalog, '') AS target_table_catalog,
  count(*) AS lineage_events,
  count(DISTINCT coalesce(source_table_full_name, source_path)) AS distinct_sources,
  count(DISTINCT coalesce(target_table_full_name, target_path)) AS distinct_targets
FROM system.access.table_lineage
WHERE event_date >= CAST(:startDate AS DATE)
  AND event_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  AND (
    :catalogPattern = '%'
    OR lower(coalesce(source_table_catalog, '')) LIKE lower(:catalogPattern)
    OR lower(coalesce(target_table_catalog, '')) LIKE lower(:catalogPattern)
  )
GROUP BY
  coalesce(source_type, ''),
  coalesce(target_type, ''),
  coalesce(source_table_catalog, ''),
  coalesce(target_table_catalog, '')
ORDER BY lineage_events DESC
LIMIT :limit;

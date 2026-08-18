-- Executes on behalf of the signed-in user.
-- Distinct source → target lineage edges for one type pair and catalog pair.
-- Do not run until the type-pair list supplies exact source/target types and catalogs.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param catalogPattern STRING
-- @param sourceType STRING
-- @param targetType STRING
-- @param sourceCatalog STRING
-- @param targetCatalog STRING
-- @param limit INT
SELECT
  coalesce(source_type, '') AS source_type,
  coalesce(target_type, '') AS target_type,
  coalesce(source_table_full_name, source_path, '') AS source_name,
  coalesce(target_table_full_name, target_path, '') AS target_name,
  coalesce(source_table_catalog, '') AS source_table_catalog,
  coalesce(target_table_catalog, '') AS target_table_catalog,
  count(*) AS lineage_events,
  max(event_time) AS last_event_time
FROM system.access.table_lineage
WHERE event_date >= CAST(:startDate AS DATE)
  AND event_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  AND coalesce(source_type, '') = :sourceType
  AND coalesce(target_type, '') = :targetType
  AND coalesce(source_table_catalog, '') = :sourceCatalog
  AND coalesce(target_table_catalog, '') = :targetCatalog
  AND (
    :catalogPattern = '%'
    OR lower(coalesce(source_table_catalog, '')) LIKE lower(:catalogPattern)
    OR lower(coalesce(target_table_catalog, '')) LIKE lower(:catalogPattern)
  )
GROUP BY
  coalesce(source_type, ''),
  coalesce(target_type, ''),
  coalesce(source_table_full_name, source_path, ''),
  coalesce(target_table_full_name, target_path, ''),
  coalesce(source_table_catalog, ''),
  coalesce(target_table_catalog, '')
ORDER BY lineage_events DESC, source_name, target_name
LIMIT :limit;

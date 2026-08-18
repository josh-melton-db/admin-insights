-- Executes on behalf of the signed-in user.
-- @param catalogPattern STRING
SELECT
  table_catalog AS catalog_name,
  count(*) AS table_count,
  sum(CASE WHEN comment IS NOT NULL AND length(comment) > 0 THEN 1 ELSE 0 END) AS commented_tables,
  sum(CASE WHEN comment IS NULL OR length(comment) = 0 THEN 1 ELSE 0 END) AS uncommented_tables
FROM system.information_schema.tables
WHERE table_catalog NOT IN ('system', 'samples', '__databricks_internal')
  AND table_schema NOT IN ('information_schema')
  AND lower(table_catalog) LIKE lower(:catalogPattern)
GROUP BY table_catalog
ORDER BY table_catalog;

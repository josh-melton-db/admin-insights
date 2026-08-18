-- Executes on behalf of the signed-in user.
-- @param catalogPattern STRING
-- @param limit INT
SELECT
  catalog_name,
  catalog_owner,
  comment,
  created,
  last_altered
FROM system.information_schema.catalogs
WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
  AND lower(catalog_name) LIKE lower(:catalogPattern)
ORDER BY catalog_name
LIMIT :limit;

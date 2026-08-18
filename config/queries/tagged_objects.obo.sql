-- Executes on behalf of the signed-in user.
-- @param catalogPattern STRING
-- @param limit INT
SELECT
  'catalog' AS object_type,
  catalog_name,
  CAST(NULL AS STRING) AS schema_name,
  CAST(NULL AS STRING) AS object_name,
  tag_name,
  tag_value
FROM system.information_schema.catalog_tags
WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
  AND lower(catalog_name) LIKE lower(:catalogPattern)

UNION ALL

SELECT
  'schema' AS object_type,
  catalog_name,
  schema_name,
  CAST(NULL AS STRING) AS object_name,
  tag_name,
  tag_value
FROM system.information_schema.schema_tags
WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
  AND lower(catalog_name) LIKE lower(:catalogPattern)

UNION ALL

SELECT
  'table' AS object_type,
  catalog_name,
  schema_name,
  table_name AS object_name,
  tag_name,
  tag_value
FROM system.information_schema.table_tags
WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
  AND lower(catalog_name) LIKE lower(:catalogPattern)

UNION ALL

SELECT
  'column' AS object_type,
  catalog_name,
  schema_name,
  concat(table_name, '.', column_name) AS object_name,
  tag_name,
  tag_value
FROM system.information_schema.column_tags
WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
  AND lower(catalog_name) LIKE lower(:catalogPattern)
ORDER BY catalog_name, schema_name, object_name, tag_name
LIMIT :limit;

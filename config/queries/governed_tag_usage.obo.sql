-- Executes on behalf of the signed-in user.
-- Tag keys ranked by how many UC assets they are assigned to, flagged when the
-- key is a governed tag. Catalog-pattern scoped like other governance lists.
-- @param catalogPattern STRING
-- @param limit INT
WITH assignments AS (
  SELECT tag_name, catalog_name
  FROM system.information_schema.catalog_tags
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)

  UNION ALL

  SELECT tag_name, catalog_name
  FROM system.information_schema.schema_tags
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)

  UNION ALL

  SELECT tag_name, catalog_name
  FROM system.information_schema.table_tags
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)

  UNION ALL

  SELECT tag_name, catalog_name
  FROM system.information_schema.column_tags
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
),
usage AS (
  SELECT
    tag_name,
    count(*) AS assignment_count,
    count(DISTINCT catalog_name) AS catalog_count
  FROM assignments
  GROUP BY tag_name
),
latest_governed AS (
  SELECT tag_key
  FROM system.tags.governed_tags
  WHERE deleted_at IS NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY tag_key ORDER BY change_time DESC) = 1
)
SELECT
  u.tag_name,
  u.assignment_count,
  u.catalog_count,
  CASE WHEN g.tag_key IS NOT NULL THEN true ELSE false END AS is_governed
FROM usage u
LEFT JOIN latest_governed g
  ON u.tag_name = g.tag_key
ORDER BY u.assignment_count DESC, u.tag_name
LIMIT :limit;

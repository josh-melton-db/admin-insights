-- Executes on behalf of the signed-in user.
-- Catalogs matching the pattern, with direct grant counts on each catalog.
-- @param catalogPattern STRING
-- @param limit INT
WITH catalogs AS (
  SELECT
    catalog_name,
    catalog_owner,
    comment
  FROM system.information_schema.catalogs
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
),
grant_stats AS (
  SELECT
    catalog_name,
    count(*) AS grant_count,
    count(CASE WHEN grantee LIKE '%@%' THEN 1 END) AS user_grant_count,
    count(CASE
      WHEN grantee NOT LIKE '%@%'
        AND grantee NOT RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN 1
    END) AS group_grant_count,
    count(CASE
      WHEN grantee RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN 1
    END) AS sp_grant_count
  FROM system.information_schema.catalog_privileges
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
    AND (
      inherited_from IS NULL
      OR inherited_from IN ('', 'NONE')
    )
  GROUP BY catalog_name
)
SELECT
  c.catalog_name,
  c.catalog_owner,
  c.comment,
  CAST(coalesce(g.grant_count, 0) AS BIGINT) AS grant_count,
  CAST(coalesce(g.user_grant_count, 0) AS BIGINT) AS user_grant_count,
  CAST(coalesce(g.group_grant_count, 0) AS BIGINT) AS group_grant_count,
  CAST(coalesce(g.sp_grant_count, 0) AS BIGINT) AS sp_grant_count
FROM catalogs c
LEFT JOIN grant_stats g
  ON c.catalog_name = g.catalog_name
ORDER BY c.catalog_name
LIMIT :limit;

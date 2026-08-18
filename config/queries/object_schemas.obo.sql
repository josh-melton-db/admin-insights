-- Executes on behalf of the signed-in user.
-- Schemas in one catalog, with direct grant counts on each schema.
-- @param catalogName STRING
-- @param limit INT
WITH schemas AS (
  SELECT
    catalog_name,
    schema_name,
    schema_owner,
    comment
  FROM system.information_schema.schemata
  WHERE catalog_name = :catalogName
    AND schema_name NOT IN ('information_schema')
),
grant_stats AS (
  SELECT
    catalog_name,
    schema_name,
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
  FROM system.information_schema.schema_privileges
  WHERE catalog_name = :catalogName
    AND schema_name NOT IN ('information_schema')
    AND (
      inherited_from IS NULL
      OR inherited_from IN ('', 'NONE')
    )
  GROUP BY catalog_name, schema_name
)
SELECT
  s.catalog_name,
  s.schema_name,
  s.schema_owner,
  s.comment,
  CAST(coalesce(g.grant_count, 0) AS BIGINT) AS grant_count,
  CAST(coalesce(g.user_grant_count, 0) AS BIGINT) AS user_grant_count,
  CAST(coalesce(g.group_grant_count, 0) AS BIGINT) AS group_grant_count,
  CAST(coalesce(g.sp_grant_count, 0) AS BIGINT) AS sp_grant_count
FROM schemas s
LEFT JOIN grant_stats g
  ON s.catalog_name = g.catalog_name
 AND s.schema_name = g.schema_name
ORDER BY s.schema_name
LIMIT :limit;

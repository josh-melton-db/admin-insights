-- Executes on behalf of the signed-in user.
-- Tables in one schema, with direct grant counts on each table.
-- Do not run estate-wide — always pass an exact catalog and schema.
-- @param catalogName STRING
-- @param schemaName STRING
-- @param limit INT
WITH tables AS (
  SELECT
    table_catalog AS catalog_name,
    table_schema AS schema_name,
    table_name,
    table_type,
    table_owner,
    comment
  FROM system.information_schema.tables
  WHERE table_catalog = :catalogName
    AND table_schema = :schemaName
),
grant_stats AS (
  SELECT
    table_catalog AS catalog_name,
    table_schema AS schema_name,
    table_name,
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
  FROM system.information_schema.table_privileges
  WHERE table_catalog = :catalogName
    AND table_schema = :schemaName
    AND (
      inherited_from IS NULL
      OR inherited_from IN ('', 'NONE')
    )
  GROUP BY table_catalog, table_schema, table_name
)
SELECT
  t.catalog_name,
  t.schema_name,
  t.table_name,
  t.table_type,
  t.table_owner,
  t.comment,
  CAST(coalesce(g.grant_count, 0) AS BIGINT) AS grant_count,
  CAST(coalesce(g.user_grant_count, 0) AS BIGINT) AS user_grant_count,
  CAST(coalesce(g.group_grant_count, 0) AS BIGINT) AS group_grant_count,
  CAST(coalesce(g.sp_grant_count, 0) AS BIGINT) AS sp_grant_count
FROM tables t
LEFT JOIN grant_stats g
  ON t.catalog_name = g.catalog_name
 AND t.schema_name = g.schema_name
 AND t.table_name = g.table_name
ORDER BY t.table_name
LIMIT :limit;

-- Executes on behalf of the signed-in user.
-- Catalog and schema grants only. Estate-wide table/volume privilege scans time out.
-- @param catalogPattern STRING
-- @param granteeKind STRING
WITH privileges AS (
  SELECT catalog_name, grantee, privilege_type
  FROM system.information_schema.catalog_privileges
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
  UNION ALL
  SELECT catalog_name, grantee, privilege_type
  FROM system.information_schema.schema_privileges
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
), classified AS (
  SELECT
    catalog_name,
    CASE
      WHEN privilege_type IN (
        'SELECT', 'READ_VOLUME', 'EXECUTE', 'USE_CATALOG', 'USE_SCHEMA', 'BROWSE'
      ) THEN 'READ'
      WHEN privilege_type IN (
        'MODIFY', 'WRITE_VOLUME', 'CREATE', 'CREATE_TABLE', 'CREATE_VIEW',
        'CREATE_FUNCTION', 'CREATE_MODEL', 'CREATE_MATERIALIZED_VIEW',
        'CREATE_VOLUME', 'CREATE_SCHEMA', 'CREATE_FOREIGN_CATALOG',
        'CREATE_CONNECTION', 'CREATE_SHARE', 'SET_SHARE_PERMISSION',
        'WRITE_FILES', 'READ_FILES'
      ) THEN 'WRITE_OR_CREATE'
      WHEN privilege_type IN (
        'MANAGE', 'OWN', 'ALL_PRIVILEGES', 'APPLY_TAG', 'REFRESH',
        'EXECUTE_CLEAN_ROOM_TASK', 'CREATE_CLEAN_ROOM'
      ) THEN 'MANAGE_OR_ADMIN'
      ELSE 'OTHER'
    END AS privilege_class
  FROM privileges
  WHERE (
    :granteeKind = 'all'
    OR grantee LIKE '%@%'
    OR grantee RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
)
SELECT
  catalog_name,
  privilege_class,
  count(*) AS grant_count
FROM classified
GROUP BY catalog_name, privilege_class
ORDER BY catalog_name, privilege_class;

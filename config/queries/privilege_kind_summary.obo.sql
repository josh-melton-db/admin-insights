-- Executes on behalf of the signed-in user.
-- Catalog and schema grants only, split by principal type. Estate-wide table
-- privilege scans time out — object explorer covers table ACLs after drill-down.
-- @param catalogPattern STRING
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
),
classified AS (
  SELECT
    CASE
      WHEN grantee LIKE '%@%' THEN 'user'
      WHEN grantee RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN 'service_principal'
      ELSE 'group'
    END AS grantee_kind,
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
    END AS privilege_class,
    grantee,
    privilege_type
  FROM privileges
)
SELECT
  grantee_kind,
  privilege_class,
  count(*) AS grant_count,
  count(DISTINCT grantee) AS principal_count
FROM classified
GROUP BY grantee_kind, privilege_class
ORDER BY
  CASE grantee_kind WHEN 'user' THEN 1 WHEN 'group' THEN 2 ELSE 3 END,
  CASE privilege_class
    WHEN 'READ' THEN 1
    WHEN 'WRITE_OR_CREATE' THEN 2
    WHEN 'MANAGE_OR_ADMIN' THEN 3
    ELSE 4
  END;

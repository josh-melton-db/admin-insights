-- Executes on behalf of the signed-in user.
-- Catalog and schema grants grouped by class. Table/function/volume grants are in
-- current_object_privilege_inventory and run only when a catalog is selected or
-- the catalog pattern is narrowed off estate-wide `%`.
-- Empty catalogName/schemaName/tableName/granteeFilter means no extra filter.
-- tableName non-empty suppresses this query's rows so the object query owns that grain.
-- @param catalogPattern STRING
-- @param catalogName STRING
-- @param schemaName STRING
-- @param tableName STRING
-- @param granteeFilter STRING
-- @param granteeKind STRING
-- @param privilegeClass STRING
-- @param limit INT
WITH privileges AS (
  SELECT
    'catalog' AS resource_type,
    catalog_name,
    CAST(NULL AS STRING) AS schema_name,
    CAST(NULL AS STRING) AS object_name,
    concat('catalog:', catalog_name) AS resource_name,
    grantee,
    privilege_type
  FROM system.information_schema.catalog_privileges
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
    AND (:catalogName = '' OR catalog_name = :catalogName)
    AND :schemaName = ''
    AND :tableName = ''

  UNION ALL

  SELECT
    'schema' AS resource_type,
    catalog_name,
    schema_name,
    CAST(NULL AS STRING) AS object_name,
    concat('schema:', catalog_name, '.', schema_name) AS resource_name,
    grantee,
    privilege_type
  FROM system.information_schema.schema_privileges
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
    AND (:catalogName = '' OR catalog_name = :catalogName)
    AND (:schemaName = '' OR schema_name = :schemaName)
    AND :tableName = ''
),
classified AS (
  SELECT
    resource_type,
    catalog_name,
    schema_name,
    object_name,
    resource_name,
    grantee,
    privilege_type,
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
    END AS privilege_class
  FROM privileges
  WHERE (:granteeFilter = '' OR lower(grantee) LIKE lower(:granteeFilter))
    AND (
      :granteeKind = 'all'
      OR (:granteeKind = 'user' AND grantee LIKE '%@%')
      OR (
        :granteeKind = 'group'
        AND grantee NOT LIKE '%@%'
        AND grantee NOT RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
      OR (
        :granteeKind = 'user_or_sp'
        AND (
          grantee LIKE '%@%'
          OR grantee RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        )
      )
      OR (
        :granteeKind = 'service_principal'
        AND grantee RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
    )
)
SELECT
  resource_type,
  catalog_name,
  schema_name,
  object_name,
  resource_name,
  grantee,
  grantee_kind,
  privilege_class,
  concat_ws(', ', array_sort(collect_set(privilege_type))) AS privileges,
  count(DISTINCT privilege_type) AS privilege_count
FROM classified
WHERE :privilegeClass = 'all' OR privilege_class = :privilegeClass
GROUP BY
  resource_type,
  catalog_name,
  schema_name,
  object_name,
  resource_name,
  grantee,
  grantee_kind,
  privilege_class
ORDER BY
  CASE privilege_class
    WHEN 'READ' THEN 1
    WHEN 'WRITE_OR_CREATE' THEN 2
    WHEN 'MANAGE_OR_ADMIN' THEN 3
    ELSE 4
  END,
  resource_name,
  grantee
LIMIT :limit;

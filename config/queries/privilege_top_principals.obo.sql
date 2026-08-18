-- Executes on behalf of the signed-in user.
-- Principals with the most catalog and schema grants. Table grants stay in
-- current_object_privilege_inventory after a catalog is selected.
-- @param catalogPattern STRING
-- @param granteeKind STRING
-- @param limit INT
WITH privileges AS (
  SELECT catalog_name, 'catalog' AS resource_type, grantee, privilege_type
  FROM system.information_schema.catalog_privileges
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)

  UNION ALL

  SELECT catalog_name, 'schema' AS resource_type, grantee, privilege_type
  FROM system.information_schema.schema_privileges
  WHERE catalog_name NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(catalog_name) LIKE lower(:catalogPattern)
),
classified AS (
  SELECT
    catalog_name,
    resource_type,
    grantee,
    privilege_type,
    CASE
      WHEN grantee LIKE '%@%' THEN 'user'
      WHEN grantee RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN 'service_principal'
      ELSE 'group'
    END AS grantee_kind
  FROM privileges
)
SELECT
  grantee,
  grantee_kind,
  count(*) AS grant_count,
  count(DISTINCT catalog_name) AS catalog_count,
  count(DISTINCT CASE WHEN resource_type = 'catalog' THEN concat(catalog_name, privilege_type) END) AS catalog_grants,
  count(DISTINCT CASE WHEN resource_type = 'schema' THEN concat(catalog_name, privilege_type) END) AS schema_grants,
  concat_ws(', ', array_sort(collect_set(privilege_type))) AS privileges
FROM classified
WHERE
  :granteeKind = 'all'
  OR (:granteeKind = 'user' AND grantee_kind = 'user')
  OR (:granteeKind = 'group' AND grantee_kind = 'group')
  OR (:granteeKind = 'service_principal' AND grantee_kind = 'service_principal')
GROUP BY grantee, grantee_kind
ORDER BY grant_count DESC, grantee
LIMIT :limit;

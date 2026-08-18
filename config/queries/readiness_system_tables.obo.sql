-- Executes on behalf of the signed-in user.
SELECT
  table_schema,
  table_name
FROM system.information_schema.tables
WHERE table_catalog = 'system'
  AND table_schema IN (
    'query',
    'billing',
    'lakeflow',
    'serving',
    'ai_gateway',
    'access',
    'storage',
    'information_schema',
    'data_classification',
    'data_quality_monitoring',
    'tags',
    'compute'
  )
ORDER BY table_schema, table_name;

-- App service principal for admin-insights (client ID from first deploy).
-- Grant no workspace or account admin role and no write privileges to system tables.
--
-- Analytics queries run on behalf of the signed-in user. The service principal
-- only needs information_schema SELECT for optional startup checks and
-- DESCRIBE access to demos.admin_insights so AppKit typegen can run at install.

GRANT USE CATALOG ON CATALOG system TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT USE SCHEMA ON SCHEMA system.information_schema TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT SELECT ON TABLE system.information_schema.catalog_privileges
  TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT SELECT ON TABLE system.information_schema.schema_privileges
  TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT SELECT ON TABLE system.information_schema.table_privileges
  TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT SELECT ON TABLE system.information_schema.routine_privileges
  TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT SELECT ON TABLE system.information_schema.volume_privileges
  TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT USE CATALOG ON CATALOG demos TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT USE SCHEMA ON SCHEMA demos.admin_insights TO `9e4c4663-646a-4845-8c98-444d75dca35b`;
GRANT SELECT ON SCHEMA demos.admin_insights TO `9e4c4663-646a-4845-8c98-444d75dca35b`;

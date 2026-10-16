-- App service principal for admin-insights (client ID from first deploy).
-- Grant no workspace or account admin role and no write privileges to system tables.
--
-- Analytics queries run on behalf of the signed-in user. The service principal
-- only needs information_schema SELECT for optional startup checks and
-- DESCRIBE access to demos.admin_insights so AppKit typegen can run at install.

GRANT USE CATALOG ON CATALOG system TO `<app-service-principal-client-id>`;
GRANT USE SCHEMA ON SCHEMA system.information_schema TO `<app-service-principal-client-id>`;
GRANT SELECT ON TABLE system.information_schema.catalog_privileges
  TO `<app-service-principal-client-id>`;
GRANT SELECT ON TABLE system.information_schema.schema_privileges
  TO `<app-service-principal-client-id>`;
GRANT SELECT ON TABLE system.information_schema.table_privileges
  TO `<app-service-principal-client-id>`;
GRANT SELECT ON TABLE system.information_schema.routine_privileges
  TO `<app-service-principal-client-id>`;
GRANT SELECT ON TABLE system.information_schema.volume_privileges
  TO `<app-service-principal-client-id>`;
GRANT USE CATALOG ON CATALOG demos TO `<app-service-principal-client-id>`;
GRANT USE SCHEMA ON SCHEMA demos.admin_insights TO `<app-service-principal-client-id>`;
GRANT SELECT ON SCHEMA demos.admin_insights TO `<app-service-principal-client-id>`;

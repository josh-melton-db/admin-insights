-- AppKit analytics files use on-behalf-of execution. Replace the group
-- placeholder with the same group configured in ADMIN_INSIGHTS_ADMIN_GROUPS,
-- then have a metastore administrator apply it.
--
-- Dashboard queries read the governed MVs in demos.admin_insights for speed.
-- Keep the system-table grants for ad-hoc forensics and privilege inventory.

GRANT USE CATALOG ON CATALOG system TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.access TO `admins`;
GRANT SELECT ON TABLE system.access.audit TO `admins`;
GRANT SELECT ON TABLE system.access.table_lineage TO `admins`;
GRANT SELECT ON TABLE system.access.workspaces_latest TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.information_schema TO `admins`;
GRANT SELECT ON SCHEMA system.information_schema TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.query TO `admins`;
GRANT SELECT ON TABLE system.query.history TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.billing TO `admins`;
GRANT SELECT ON TABLE system.billing.usage TO `admins`;
GRANT SELECT ON TABLE system.billing.list_prices TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.lakeflow TO `admins`;
GRANT SELECT ON TABLE system.lakeflow.jobs TO `admins`;
GRANT SELECT ON TABLE system.lakeflow.job_run_timeline TO `admins`;
GRANT SELECT ON TABLE system.lakeflow.job_task_run_timeline TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.compute TO `admins`;
GRANT SELECT ON TABLE system.compute.clusters TO `admins`;
GRANT SELECT ON TABLE system.compute.node_timeline TO `admins`;
GRANT SELECT ON TABLE system.compute.warehouses TO `admins`;
GRANT SELECT ON TABLE system.compute.warehouse_events TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.serving TO `admins`;
GRANT SELECT ON TABLE system.serving.endpoint_usage TO `admins`;
GRANT SELECT ON TABLE system.serving.served_entities TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.ai_gateway TO `admins`;
GRANT SELECT ON TABLE system.ai_gateway.usage TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.storage TO `admins`;
GRANT SELECT ON TABLE system.storage.table_metrics_history TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.tags TO `admins`;
GRANT SELECT ON TABLE system.tags.governed_tags TO `admins`;

-- Optional. These two tables are not currently granted to the DEFAULT profile.
-- Sensitive-object and row-count panels stay on “not collected” until applied.
GRANT USE SCHEMA ON SCHEMA system.data_classification TO `admins`;
GRANT SELECT ON TABLE system.data_classification.results TO `admins`;
GRANT USE SCHEMA ON SCHEMA system.data_quality_monitoring TO `admins`;
GRANT SELECT ON TABLE system.data_quality_monitoring.table_results TO `admins`;

GRANT USE CATALOG ON CATALOG demos TO `admins`;
GRANT USE SCHEMA ON SCHEMA demos.admin_insights TO `admins`;
GRANT SELECT ON SCHEMA demos.admin_insights TO `admins`;

-- Executes on behalf of the signed-in user.
-- Estate return: active users from the 90-day audit MV (not query history),
-- plus tables, jobs, serving endpoints, and models this principal can see.
-- Do not scan system.access.audit live.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param catalogPattern STRING
WITH audit_actors AS (
  SELECT
    count(DISTINCT CASE WHEN actor LIKE '%@%' THEN actor END) AS active_users,
    count(DISTINCT CASE
      WHEN actor RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN actor
    END) AS active_service_principals,
    count(DISTINCT actor) AS active_principals
  FROM demos.admin_insights.actor_activity_daily
  WHERE activity_date >= CAST(:startDate AS DATE)
    AND activity_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
),
tables_managed AS (
  SELECT count(*) AS table_count
  FROM system.information_schema.tables
  WHERE table_catalog NOT IN ('system', 'samples', '__databricks_internal')
    AND lower(table_catalog) NOT LIKE '__databricks_internal%'
    AND table_schema <> 'information_schema'
    AND lower(table_catalog) LIKE lower(:catalogPattern)
),
jobs_managed AS (
  SELECT count(*) AS job_count
  FROM (
    SELECT workspace_id, job_id
    FROM system.lakeflow.jobs
    WHERE delete_time IS NULL
      AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY workspace_id, job_id
      ORDER BY change_time DESC
    ) = 1
  )
),
serving_latest AS (
  SELECT
    workspace_id,
    endpoint_id,
    endpoint_name,
    entity_type,
    entity_name,
    served_entity_name,
    custom_model_config.min_concurrency AS custom_min_concurrency,
    feature_spec_config.min_concurrency AS feature_min_concurrency,
    foundation_model_config.min_provisioned_throughput AS foundation_min_throughput
  FROM system.serving.served_entities
  WHERE endpoint_delete_time IS NULL
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY workspace_id, endpoint_id, served_entity_id
    ORDER BY change_time DESC
  ) = 1
),
serving_endpoints AS (
  SELECT
    workspace_id,
    endpoint_id,
    CASE
      WHEN max(CASE
        WHEN coalesce(custom_min_concurrency, feature_min_concurrency) > 0
          OR coalesce(foundation_min_throughput, 0) > 0
        THEN 1 ELSE 0
      END) = 1 THEN 'does_not_scale_to_zero'
      WHEN max(CASE
        WHEN custom_min_concurrency = 0
          OR feature_min_concurrency = 0
          OR foundation_min_throughput = 0
        THEN 1 ELSE 0
      END) = 1 THEN 'scales_to_zero'
      ELSE 'unknown'
    END AS scale_to_zero_band
  FROM serving_latest
  WHERE coalesce(endpoint_name, '') NOT LIKE 'databricks-%'
  GROUP BY workspace_id, endpoint_id
),
serving_managed AS (
  SELECT
    e.serving_endpoint_count,
    e.serving_always_on_count,
    e.serving_scale_to_zero_count,
    m.managed_model_count
  FROM (
    SELECT
      count(*) AS serving_endpoint_count,
      count(CASE WHEN scale_to_zero_band = 'does_not_scale_to_zero' THEN 1 END) AS serving_always_on_count,
      count(CASE WHEN scale_to_zero_band = 'scales_to_zero' THEN 1 END) AS serving_scale_to_zero_count
    FROM serving_endpoints
  ) e
  CROSS JOIN (
    SELECT count(DISTINCT CASE
      WHEN entity_type IN ('CUSTOM_MODEL', 'EXTERNAL_MODEL') THEN coalesce(entity_name, served_entity_name)
    END) AS managed_model_count
    FROM serving_latest
  ) m
)
SELECT
  coalesce(a.active_users, 0) AS active_users,
  coalesce(a.active_service_principals, 0) AS active_service_principals,
  coalesce(a.active_principals, 0) AS active_principals,
  coalesce(t.table_count, 0) AS table_count,
  coalesce(j.job_count, 0) AS job_count,
  coalesce(s.serving_endpoint_count, 0) AS serving_endpoint_count,
  coalesce(s.serving_always_on_count, 0) AS serving_always_on_count,
  coalesce(s.serving_scale_to_zero_count, 0) AS serving_scale_to_zero_count,
  coalesce(s.managed_model_count, 0) AS managed_model_count,
  current_timestamp() AS as_of,
  'actor_activity_daily + information_schema.tables + lakeflow.jobs + serving.served_entities' AS metric_source
FROM audit_actors a
CROSS JOIN tables_managed t
CROSS JOIN jobs_managed j
CROSS JOIN serving_managed s;

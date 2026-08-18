-- Executes on behalf of the signed-in user.
-- Serving endpoint billing evidence excluding Databricks-hosted foundation
-- model names (databricks-%). Least recently used first. Scale-to-zero is
-- inferred from latest served_entities min concurrency / provisioned throughput.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH billed AS (
  SELECT
    u.workspace_id,
    coalesce(u.usage_metadata.endpoint_name, 'unknown') AS endpoint_name,
    coalesce(sum(u.usage_quantity), 0) AS dbus,
    max(u.usage_date) AS last_usage_date
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.usage_metadata.endpoint_name IS NOT NULL
    AND u.usage_metadata.endpoint_name NOT LIKE 'databricks-%'
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY u.workspace_id, coalesce(u.usage_metadata.endpoint_name, 'unknown')
),
latest_entities AS (
  SELECT
    workspace_id,
    endpoint_id,
    endpoint_name,
    served_entity_id,
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
endpoint_scale AS (
  SELECT
    workspace_id,
    endpoint_name,
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
  FROM latest_entities
  GROUP BY workspace_id, endpoint_name
),
requests AS (
  SELECT
    e.workspace_id,
    e.endpoint_name,
    count(*) AS query_count
  FROM system.serving.endpoint_usage u
  INNER JOIN latest_entities e
    ON u.workspace_id = e.workspace_id
    AND u.served_entity_id = e.served_entity_id
  WHERE DATE(u.request_time) >= CAST(:startDate AS DATE)
    AND DATE(u.request_time) <= CAST(:endDate AS DATE)
  GROUP BY e.workspace_id, e.endpoint_name
)
SELECT
  b.workspace_id,
  b.endpoint_name,
  b.dbus,
  b.last_usage_date,
  coalesce(s.scale_to_zero_band, 'unknown') AS scale_to_zero_band,
  coalesce(r.query_count, 0) AS query_count
FROM billed b
LEFT JOIN endpoint_scale s
  ON b.workspace_id = s.workspace_id
  AND b.endpoint_name = s.endpoint_name
LEFT JOIN requests r
  ON b.workspace_id = r.workspace_id
  AND b.endpoint_name = r.endpoint_name
ORDER BY b.last_usage_date ASC NULLS FIRST, b.endpoint_name
LIMIT :limit;

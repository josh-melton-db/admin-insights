-- Executes on behalf of the signed-in user.
-- Model serving endpoints with list-price spend and no endpoint_usage requests.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH serving_usage_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown') AS endpoint_name,
    u.usage_metadata.endpoint_id AS endpoint_id,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.billing_origin_product = 'MODEL_SERVING'
    AND coalesce(u.usage_metadata.endpoint_name, '') NOT LIKE 'databricks-%'
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown'),
    u.usage_metadata.endpoint_id
),
serving_cost AS (
  SELECT
    u.workspace_id,
    u.endpoint_name,
    u.endpoint_id,
    coalesce(sum(u.dbus), 0) AS dbus,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM serving_usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.endpoint_name, u.endpoint_id
),
latest_entities AS (
  SELECT
    workspace_id,
    endpoint_id,
    endpoint_name,
    served_entity_id,
    served_entity_name,
    entity_type,
    entity_name,
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
    endpoint_id,
    max(endpoint_name) AS endpoint_name,
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
  GROUP BY workspace_id, endpoint_id
),
requests AS (
  SELECT
    e.workspace_id,
    e.endpoint_name,
    e.endpoint_id,
    count(*) AS request_count,
    max(u.request_time) AS last_request_time
  FROM system.serving.endpoint_usage u
  INNER JOIN latest_entities e
    ON u.workspace_id = e.workspace_id
    AND u.served_entity_id = e.served_entity_id
  WHERE DATE(u.request_time) >= CAST(:startDate AS DATE)
    AND DATE(u.request_time) <= CAST(:endDate AS DATE)
  GROUP BY e.workspace_id, e.endpoint_name, e.endpoint_id
)
SELECT
  c.workspace_id,
  c.endpoint_name,
  c.endpoint_id,
  c.dbus,
  c.list_cost,
  coalesce(r.request_count, 0) AS request_count,
  r.last_request_time,
  CASE WHEN coalesce(r.request_count, 0) = 0 THEN 'no_queries' ELSE 'has_queries' END AS usage_band,
  coalesce(s.scale_to_zero_band, 'unknown') AS scale_to_zero_band,
  'system.billing.usage + system.serving.endpoint_usage' AS metric_source
FROM serving_cost c
LEFT JOIN requests r
  ON c.workspace_id = r.workspace_id
  AND (
    (c.endpoint_id IS NOT NULL AND c.endpoint_id = r.endpoint_id)
    OR c.endpoint_name = r.endpoint_name
  )
LEFT JOIN endpoint_scale s
  ON c.workspace_id = s.workspace_id
  AND (
    (c.endpoint_id IS NOT NULL AND c.endpoint_id = s.endpoint_id)
    OR c.endpoint_name = s.endpoint_name
  )
WHERE coalesce(r.request_count, 0) = 0
ORDER BY c.list_cost DESC
LIMIT :limit;

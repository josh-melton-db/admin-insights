-- Executes on behalf of the signed-in user.
-- Daily wasted spend: billed resources with no usage signal in the window.
-- idle_serving_always_on = MODEL_SERVING with zero requests and min concurrency / throughput > 0.
-- idle_serving_scale_to_zero = MODEL_SERVING with zero requests that scale to zero or have unknown config.
-- vector_search_no_index = VECTOR_SEARCH usage rows with no index_id.
-- Agent Bricks ka-% / mas-% Vector Search endpoints are excluded from that band.
-- app_no_user_obo = APPS billing with zero user-authorization (OBO) events.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
WITH usage_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.billing_origin_product AS product,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown') AS endpoint_name,
    u.usage_metadata.endpoint_id AS endpoint_id,
    nullif(u.usage_metadata.index_id, '') AS index_id,
    coalesce(u.usage_metadata.app_id, '') AS app_id,
    coalesce(u.usage_metadata.app_name, '') AS app_name,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.billing_origin_product IN ('MODEL_SERVING', 'VECTOR_SEARCH', 'APPS')
    AND coalesce(u.usage_metadata.endpoint_name, '') NOT LIKE 'databricks-%'
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.billing_origin_product,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown'),
    u.usage_metadata.endpoint_id,
    nullif(u.usage_metadata.index_id, ''),
    coalesce(u.usage_metadata.app_id, ''),
    coalesce(u.usage_metadata.app_name, '')
),
priced AS (
  SELECT
    u.workspace_id,
    u.usage_date,
    u.product,
    u.endpoint_name,
    u.endpoint_id,
    u.index_id,
    u.app_id,
    u.app_name,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY
    u.workspace_id,
    u.usage_date,
    u.product,
    u.endpoint_name,
    u.endpoint_id,
    u.index_id,
    u.app_id,
    u.app_name
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
serving_with_requests AS (
  SELECT DISTINCT
    e.workspace_id,
    e.endpoint_name,
    e.endpoint_id
  FROM system.serving.endpoint_usage u
  INNER JOIN latest_entities e
    ON u.workspace_id = e.workspace_id
    AND u.served_entity_id = e.served_entity_id
  WHERE DATE(u.request_time) >= CAST(:startDate AS DATE)
    AND DATE(u.request_time) <= CAST(:endDate AS DATE)
),
apps_with_obo AS (
  SELECT DISTINCT
    workspace_id,
    acting_resource
  FROM demos.admin_insights.app_obo_activity_daily
  WHERE activity_date >= CAST(:startDate AS DATE)
    AND activity_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
),
classified AS (
  SELECT
    p.usage_date,
    CASE
      WHEN p.product = 'MODEL_SERVING'
        AND r.endpoint_name IS NULL
        AND coalesce(s.scale_to_zero_band, 'unknown') = 'does_not_scale_to_zero'
        THEN 'idle_serving_always_on'
      WHEN p.product = 'MODEL_SERVING'
        AND r.endpoint_name IS NULL
        THEN 'idle_serving_scale_to_zero'
      WHEN p.product = 'VECTOR_SEARCH'
        AND p.index_id IS NULL
        AND lower(coalesce(p.endpoint_name, '')) NOT LIKE 'ka-%'
        AND lower(coalesce(p.endpoint_name, '')) NOT LIKE 'mas-%'
        THEN 'vector_search_no_index'
      WHEN p.product = 'APPS'
        AND NOT EXISTS (
          SELECT 1
          FROM apps_with_obo o
          WHERE o.workspace_id = p.workspace_id
            AND o.acting_resource IN (p.app_id, p.app_name)
        )
        THEN 'app_no_user_obo'
      ELSE NULL
    END AS waste_kind,
    p.list_cost
  FROM priced p
  LEFT JOIN serving_with_requests r
    ON p.product = 'MODEL_SERVING'
    AND p.workspace_id = r.workspace_id
    AND (
      (p.endpoint_id IS NOT NULL AND p.endpoint_id = r.endpoint_id)
      OR p.endpoint_name = r.endpoint_name
    )
  LEFT JOIN endpoint_scale s
    ON p.product = 'MODEL_SERVING'
    AND p.workspace_id = s.workspace_id
    AND (
      (p.endpoint_id IS NOT NULL AND p.endpoint_id = s.endpoint_id)
      OR p.endpoint_name = s.endpoint_name
    )
)
SELECT
  usage_date,
  coalesce(sum(CASE WHEN waste_kind = 'idle_serving_always_on' THEN list_cost END), 0) AS idle_always_on_serving_spend,
  coalesce(sum(CASE WHEN waste_kind = 'idle_serving_scale_to_zero' THEN list_cost END), 0) AS idle_scale_to_zero_serving_spend,
  coalesce(sum(CASE WHEN waste_kind = 'vector_search_no_index' THEN list_cost END), 0) AS vector_search_no_index_spend,
  coalesce(sum(CASE WHEN waste_kind = 'app_no_user_obo' THEN list_cost END), 0) AS app_no_user_obo_spend,
  coalesce(sum(CASE WHEN waste_kind IS NOT NULL THEN list_cost END), 0) AS wasted_spend
FROM classified
GROUP BY usage_date
ORDER BY usage_date;

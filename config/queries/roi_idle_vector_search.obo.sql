-- Executes on behalf of the signed-in user.
-- Vector Search endpoints with billing and no index_id on usage records.
-- Agent Bricks (ka-% Knowledge Assistant, mas-% Supervisor) own their indexes
-- and do not populate index_id, so they are not unused.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH vs_usage_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown') AS endpoint_name,
    u.usage_metadata.endpoint_id AS endpoint_id,
    nullif(u.usage_metadata.index_id, '') AS index_id,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.billing_origin_product = 'VECTOR_SEARCH'
    AND lower(coalesce(u.usage_metadata.endpoint_name, '')) NOT LIKE 'ka-%'
    AND lower(coalesce(u.usage_metadata.endpoint_name, '')) NOT LIKE 'mas-%'
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown'),
    u.usage_metadata.endpoint_id,
    nullif(u.usage_metadata.index_id, '')
),
vs_cost AS (
  SELECT
    u.workspace_id,
    u.endpoint_name,
    u.endpoint_id,
    count(DISTINCT u.index_id) AS index_count,
    coalesce(sum(u.dbus), 0) AS dbus,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM vs_usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.endpoint_name, u.endpoint_id
)
SELECT
  workspace_id,
  endpoint_name,
  endpoint_id,
  index_count,
  dbus,
  list_cost,
  CASE WHEN index_count = 0 THEN 'no_indexes' ELSE 'has_indexes' END AS usage_band,
  'system.billing.usage' AS metric_source
FROM vs_cost
WHERE index_count = 0
ORDER BY list_cost DESC
LIMIT :limit;

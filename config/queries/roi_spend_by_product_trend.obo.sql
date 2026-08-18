-- Executes on behalf of the signed-in user.
-- Daily attributed spend grouped into product families for a stacked trend.
-- Each family has a downstream-return path or a recommended action in the UI.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
WITH usage_daily AS (
  SELECT
    u.account_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    CASE
      WHEN u.billing_origin_product = 'JOBS' THEN 'jobs'
      WHEN coalesce(u.billing_origin_product, '') LIKE '%SQL%' THEN 'sql'
      WHEN u.billing_origin_product = 'MODEL_SERVING' THEN 'serving'
      WHEN u.billing_origin_product = 'APPS' THEN 'apps'
      WHEN u.billing_origin_product = 'VECTOR_SEARCH' THEN 'vector_search'
      WHEN u.billing_origin_product = 'GENIE' THEN 'genie'
      ELSE 'other'
    END AS product_group,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    CASE
      WHEN u.billing_origin_product = 'JOBS' THEN 'jobs'
      WHEN coalesce(u.billing_origin_product, '') LIKE '%SQL%' THEN 'sql'
      WHEN u.billing_origin_product = 'MODEL_SERVING' THEN 'serving'
      WHEN u.billing_origin_product = 'APPS' THEN 'apps'
      WHEN u.billing_origin_product = 'VECTOR_SEARCH' THEN 'vector_search'
      WHEN u.billing_origin_product = 'GENIE' THEN 'genie'
      ELSE 'other'
    END
),
priced AS (
  SELECT
    u.usage_date,
    u.product_group,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.usage_date, u.product_group
)
SELECT
  usage_date,
  coalesce(sum(CASE WHEN product_group = 'jobs' THEN list_cost END), 0) AS jobs_spend,
  coalesce(sum(CASE WHEN product_group = 'sql' THEN list_cost END), 0) AS sql_spend,
  coalesce(sum(CASE WHEN product_group = 'serving' THEN list_cost END), 0) AS serving_spend,
  coalesce(sum(CASE WHEN product_group = 'apps' THEN list_cost END), 0) AS apps_spend,
  coalesce(sum(CASE WHEN product_group = 'vector_search' THEN list_cost END), 0) AS vector_search_spend,
  coalesce(sum(CASE WHEN product_group = 'genie' THEN list_cost END), 0) AS genie_spend,
  coalesce(sum(CASE WHEN product_group = 'other' THEN list_cost END), 0) AS other_spend
FROM priced
GROUP BY usage_date
ORDER BY usage_date;

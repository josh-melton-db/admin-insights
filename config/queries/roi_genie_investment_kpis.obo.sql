-- Executes on behalf of the signed-in user.
-- Genie investment: free vs billed DBUs. GENIE_FREE_USAGE has no list price.
-- Estimated free equivalent uses a proxy billed Genie SKU * 0.75 promo through 2027-01-31.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
WITH genie_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.usage_metadata.genie.surface, 'unknown') AS genie_surface,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.billing_origin_product = 'GENIE'
    AND u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.usage_metadata.genie.surface, 'unknown')
),
paid AS (
  SELECT
    coalesce(sum(g.dbus), 0) AS paid_dbus,
    coalesce(sum(g.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS paid_list_cost
  FROM genie_daily g
  LEFT JOIN system.billing.list_prices p
    ON g.account_id = p.account_id
    AND g.sku_name = p.sku_name
    AND g.cloud = p.cloud
    AND g.usage_unit = p.usage_unit
    AND g.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR g.usage_date < CAST(p.price_end_time AS DATE))
  WHERE g.sku_name <> 'GENIE_FREE_USAGE'
),
free_rows AS (
  SELECT
    g.workspace_id,
    g.genie_surface,
    g.usage_date,
    g.dbus
  FROM genie_daily g
  WHERE g.sku_name = 'GENIE_FREE_USAGE'
),
proxy_sku AS (
  SELECT
    workspace_id,
    max_by(sku_name, usage_date) AS proxy_sku_name
  FROM system.billing.usage
  WHERE billing_origin_product = 'GENIE'
    AND sku_name <> 'GENIE_FREE_USAGE'
    AND usage_date >= date_sub(current_date(), 30)
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  GROUP BY workspace_id
),
free_priced AS (
  SELECT
    coalesce(sum(f.dbus), 0) AS free_dbus,
    coalesce(sum(
      f.dbus
      * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)
      * CASE WHEN current_date() <= DATE '2027-01-31' THEN 0.75 ELSE 1 END
    ), 0) AS estimated_free_list_cost
  FROM free_rows f
  LEFT JOIN proxy_sku s
    ON f.workspace_id = s.workspace_id
  LEFT JOIN system.billing.list_prices p
    ON s.proxy_sku_name = p.sku_name
    AND f.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR f.usage_date < CAST(p.price_end_time AS DATE))
)
SELECT
  coalesce(fr.free_dbus, 0) AS free_dbus,
  coalesce(pd.paid_dbus, 0) AS paid_dbus,
  coalesce(pd.paid_list_cost, 0) AS paid_list_cost,
  coalesce(fr.estimated_free_list_cost, 0) AS estimated_free_list_cost,
  150 AS genie_code_monthly_free_dbus,
  DATE '2027-01-31' AS one_agents_free_through,
  current_timestamp() AS as_of,
  'system.billing.usage (GENIE / GENIE_FREE_USAGE)' AS metric_source
FROM paid pd
CROSS JOIN free_priced fr;

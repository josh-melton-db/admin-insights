-- Executes on behalf of the signed-in user.
-- Daily Genie free vs billed DBUs. Free SKU has no list price.
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
    u.usage_date
),
priced AS (
  SELECT
    g.usage_date,
    CASE WHEN g.sku_name = 'GENIE_FREE_USAGE' THEN g.dbus ELSE 0 END AS free_dbus,
    CASE WHEN g.sku_name <> 'GENIE_FREE_USAGE' THEN g.dbus ELSE 0 END AS paid_dbus,
    CASE
      WHEN g.sku_name <> 'GENIE_FREE_USAGE'
        THEN g.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)
      ELSE 0
    END AS paid_list_cost
  FROM genie_daily g
  LEFT JOIN system.billing.list_prices p
    ON g.account_id = p.account_id
    AND g.sku_name = p.sku_name
    AND g.cloud = p.cloud
    AND g.usage_unit = p.usage_unit
    AND g.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR g.usage_date < CAST(p.price_end_time AS DATE))
)
SELECT
  usage_date,
  coalesce(sum(free_dbus), 0) AS free_dbus,
  coalesce(sum(paid_dbus), 0) AS paid_dbus,
  coalesce(sum(paid_list_cost), 0) AS paid_list_cost
FROM priced
GROUP BY usage_date
ORDER BY usage_date;

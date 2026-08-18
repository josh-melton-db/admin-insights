-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH tagged AS (
  SELECT
    u.account_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    tag_key,
    tag_value,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  LATERAL VIEW explode(u.custom_tags) tag_table AS tag_key, tag_value
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY u.account_id, u.sku_name, u.cloud, u.usage_unit, u.usage_date, tag_key, tag_value
)
SELECT
  t.tag_key,
  t.tag_value,
  coalesce(sum(t.dbus), 0) AS dbus,
  coalesce(sum(t.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
FROM tagged t
LEFT JOIN system.billing.list_prices p
  ON t.account_id = p.account_id
  AND t.sku_name = p.sku_name
  AND t.cloud = p.cloud
  AND t.usage_unit = p.usage_unit
  AND t.usage_date >= CAST(p.price_start_time AS DATE)
  AND (p.price_end_time IS NULL OR t.usage_date < CAST(p.price_end_time AS DATE))
GROUP BY t.tag_key, t.tag_value
ORDER BY list_cost DESC
LIMIT :limit;

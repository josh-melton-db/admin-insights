-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH usage_daily AS (
  SELECT
    u.account_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.usage_metadata.usage_policy_id, u.usage_metadata.budget_policy_id, 'unassigned') AS usage_policy_id,
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
    coalesce(u.usage_metadata.usage_policy_id, u.usage_metadata.budget_policy_id, 'unassigned')
)
SELECT
  u.usage_policy_id,
  coalesce(sum(u.dbus), 0) AS dbus,
  coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
FROM usage_daily u
LEFT JOIN system.billing.list_prices p
  ON u.account_id = p.account_id
  AND u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND u.usage_unit = p.usage_unit
  AND u.usage_date >= CAST(p.price_start_time AS DATE)
  AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
GROUP BY u.usage_policy_id
ORDER BY list_cost DESC
LIMIT :limit;

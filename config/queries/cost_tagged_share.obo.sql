-- Executes on behalf of the signed-in user.
-- List-price spend that has at least one custom tag versus none. Governance Hub
-- Cost "tagged spend" tile.
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
      WHEN u.custom_tags IS NULL OR size(u.custom_tags) = 0 THEN 'untagged'
      ELSE 'tagged'
    END AS tag_status,
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
      WHEN u.custom_tags IS NULL OR size(u.custom_tags) = 0 THEN 'untagged'
      ELSE 'tagged'
    END
),
priced AS (
  SELECT
    u.tag_status,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.tag_status
)
SELECT
  coalesce(sum(CASE WHEN tag_status = 'tagged' THEN list_cost END), 0) AS tagged_cost,
  coalesce(sum(CASE WHEN tag_status = 'untagged' THEN list_cost END), 0) AS untagged_cost,
  coalesce(sum(list_cost), 0) AS total_cost,
  try_divide(
    coalesce(sum(CASE WHEN tag_status = 'tagged' THEN list_cost END), 0),
    nullif(coalesce(sum(list_cost), 0), 0)
  ) AS tagged_share
FROM priced;

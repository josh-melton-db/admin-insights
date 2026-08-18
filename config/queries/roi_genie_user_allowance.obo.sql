-- Executes on behalf of the signed-in user.
-- Current calendar-month Genie Code free allowance (150 DBUs per user, not SPs).
-- Genie One and Genie Agents user usage is promotional-free through 2027-01-31
-- and does not consume the 150 DBU Code allowance.
-- @param workspaceScope STRING
-- @param limit INT
WITH month_usage AS (
  SELECT
    u.workspace_id,
    coalesce(u.identity_metadata.run_as, 'unknown') AS run_as,
    coalesce(u.usage_metadata.genie.surface, 'unknown') AS genie_surface,
    u.sku_name,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.billing_origin_product = 'GENIE'
    AND u.usage_date >= date_trunc('MONTH', current_date())
    AND u.usage_date <= current_date()
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.workspace_id,
    coalesce(u.identity_metadata.run_as, 'unknown'),
    coalesce(u.usage_metadata.genie.surface, 'unknown'),
    u.sku_name
),
by_user AS (
  SELECT
    workspace_id,
    run_as,
    CASE
      WHEN run_as RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN 'service_principal'
      WHEN run_as LIKE '%@%' THEN 'user'
      ELSE 'other'
    END AS principal_kind,
    coalesce(sum(CASE
      WHEN sku_name = 'GENIE_FREE_USAGE' AND genie_surface = 'GENIE_CODE' THEN dbus
    END), 0) AS genie_code_free_dbus,
    coalesce(sum(CASE
      WHEN sku_name = 'GENIE_FREE_USAGE' AND genie_surface = 'GENIE_ONE' THEN dbus
    END), 0) AS genie_one_free_dbus,
    coalesce(sum(CASE
      WHEN sku_name = 'GENIE_FREE_USAGE' AND genie_surface = 'GENIE_AGENTS' THEN dbus
    END), 0) AS genie_agents_free_dbus,
    coalesce(sum(CASE WHEN sku_name = 'GENIE_FREE_USAGE' THEN dbus END), 0) AS total_free_dbus,
    coalesce(sum(CASE WHEN sku_name <> 'GENIE_FREE_USAGE' THEN dbus END), 0) AS paid_dbus
  FROM month_usage
  GROUP BY
    workspace_id,
    run_as,
    CASE
      WHEN run_as RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN 'service_principal'
      WHEN run_as LIKE '%@%' THEN 'user'
      ELSE 'other'
    END
)
SELECT
  workspace_id,
  run_as,
  principal_kind,
  genie_code_free_dbus,
  CASE
    WHEN principal_kind = 'user' THEN greatest(0, 150 - genie_code_free_dbus)
    ELSE 0
  END AS genie_code_free_dbus_remaining,
  CASE
    WHEN principal_kind = 'user' AND genie_code_free_dbus >= 150 THEN 'code_allowance_used'
    WHEN principal_kind = 'service_principal' THEN 'no_user_allowance'
    WHEN principal_kind = 'user' THEN 'within_code_allowance'
    ELSE 'other'
  END AS allowance_band,
  genie_one_free_dbus,
  genie_agents_free_dbus,
  total_free_dbus,
  paid_dbus,
  150 AS genie_code_monthly_free_dbus
FROM by_user
ORDER BY
  CASE WHEN principal_kind = 'service_principal' THEN 0 ELSE 1 END,
  paid_dbus DESC,
  genie_code_free_dbus DESC,
  run_as
LIMIT :limit;

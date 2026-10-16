-- Executes on behalf of the signed-in user.
-- App compute billing plus user-authorization (OBO) actions from the 90-day MV.
-- Billing on/off is not usage. OBO rows match an app on oauth2_app_client_id
-- (the last segment of identity_metadata.acting_resource), never on workspace:
-- most OBO rows have workspace_id 0. Billing only has app_id, so app_id maps to
-- oauth2_app_client_id through demos.admin_insights.monitor_apps_inventory_snapshot.
-- That table comes from the apps-monitoring bundle (bundles/apps-monitoring)
-- with its default monitor_ name prefix, and covers that bundle's workspace only.
-- Billed apps missing from it get usage_band 'obo_unmapped' and NULL OBO
-- counts: unknown, not "no users".
-- The app's own service principal is not a user: OBO rows whose user_email is
-- not email-shaped or equals the app's service_principal_client_id are excluded.
-- user_api_scopes come from the latest createApp/updateApp payload in the MV.
-- Least recently billed apps first.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH billed AS (
  SELECT
    u.workspace_id,
    coalesce(u.usage_metadata.app_id, 'unknown') AS app_id,
    coalesce(u.usage_metadata.app_name, 'unknown') AS app_name,
    coalesce(sum(u.usage_quantity), 0) AS dbus,
    max(u.usage_date) AS last_usage_date
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.usage_metadata.app_id IS NOT NULL
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.workspace_id,
    coalesce(u.usage_metadata.app_id, 'unknown'),
    coalesce(u.usage_metadata.app_name, 'unknown')
),
app_map AS (
  SELECT DISTINCT
    workspace_id,
    app_id,
    oauth2_app_client_id,
    service_principal_client_id
  FROM demos.admin_insights.monitor_apps_inventory_snapshot
  WHERE oauth2_app_client_id IS NOT NULL
),
obo AS (
  SELECT
    b.workspace_id,
    b.app_id,
    coalesce(sum(o.event_count), 0) AS user_obo_events,
    count(DISTINCT o.user_email) AS user_obo_users,
    max(o.activity_date) AS last_obo_date
  FROM billed b
  INNER JOIN app_map m
    ON m.workspace_id = b.workspace_id
    AND m.app_id = b.app_id
  INNER JOIN demos.admin_insights.app_obo_activity_daily o
    ON o.oauth2_app_client_id = m.oauth2_app_client_id
    AND o.user_email LIKE '%@%'
    AND o.user_email IS DISTINCT FROM m.service_principal_client_id
    AND o.activity_date >= CAST(:startDate AS DATE)
    AND o.activity_date <= CAST(:endDate AS DATE)
  GROUP BY b.workspace_id, b.app_id
),
latest_config AS (
  SELECT
    workspace_id,
    app_name,
    user_api_scopes,
    event_time AS last_config_time
  FROM demos.admin_insights.app_config_events_daily
  WHERE activity_date >= date_sub(current_date(), 90)
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY workspace_id, app_name
    ORDER BY event_time DESC
  ) = 1
)
SELECT
  b.workspace_id,
  b.app_id,
  b.app_name,
  b.dbus,
  b.last_usage_date,
  CASE WHEN m.app_id IS NULL THEN NULL ELSE coalesce(o.user_obo_events, 0) END AS user_obo_events,
  CASE WHEN m.app_id IS NULL THEN NULL ELSE coalesce(o.user_obo_users, 0) END AS user_obo_users,
  o.last_obo_date,
  c.user_api_scopes,
  CASE
    WHEN c.app_name IS NULL THEN 'scopes_unknown'
    WHEN c.user_api_scopes IS NULL
      OR trim(c.user_api_scopes) IN ('', '[]', 'null')
      THEN 'no_user_api_scopes'
    ELSE 'has_user_api_scopes'
  END AS scope_band,
  CASE
    WHEN m.app_id IS NULL THEN 'obo_unmapped'
    WHEN coalesce(o.user_obo_events, 0) > 0 THEN 'has_user_obo'
    WHEN c.app_name IS NOT NULL
      AND (
        c.user_api_scopes IS NULL
        OR trim(c.user_api_scopes) IN ('', '[]', 'null')
      )
      THEN 'app_sp_only_suspected'
    ELSE 'no_user_obo'
  END AS usage_band
FROM billed b
LEFT JOIN app_map m
  ON b.workspace_id = m.workspace_id
  AND b.app_id = m.app_id
LEFT JOIN obo o
  ON b.workspace_id = o.workspace_id
  AND b.app_id = o.app_id
LEFT JOIN latest_config c
  ON b.workspace_id = c.workspace_id
  AND b.app_name = c.app_name
ORDER BY b.last_usage_date ASC NULLS FIRST, b.app_name
LIMIT :limit;

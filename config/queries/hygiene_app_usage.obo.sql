-- Executes on behalf of the signed-in user.
-- App compute billing plus user-authorization (OBO) actions from the 90-day MV.
-- Billing on/off is not usage. OBO events are identity_metadata.acting_resource.
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
obo AS (
  SELECT
    b.workspace_id,
    b.app_id,
    coalesce(sum(o.event_count), 0) AS user_obo_events,
    count(DISTINCT o.user_email) AS user_obo_users,
    max(o.activity_date) AS last_obo_date
  FROM billed b
  INNER JOIN demos.admin_insights.app_obo_activity_daily o
    ON o.workspace_id = b.workspace_id
    AND o.acting_resource IN (b.app_id, b.app_name)
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
  coalesce(o.user_obo_events, 0) AS user_obo_events,
  coalesce(o.user_obo_users, 0) AS user_obo_users,
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
LEFT JOIN obo o
  ON b.workspace_id = o.workspace_id
  AND b.app_id = o.app_id
LEFT JOIN latest_config c
  ON b.workspace_id = c.workspace_id
  AND b.app_name = c.app_name
ORDER BY b.last_usage_date ASC NULLS FIRST, b.app_name
LIMIT :limit;

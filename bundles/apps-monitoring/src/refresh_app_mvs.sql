-- Create-or-replace and unschedule this bundle's Databricks Apps materialized
-- views, <name_prefix>app_obo_activity_daily, <name_prefix>app_config_events_daily,
-- and <name_prefix>app_access_activity_daily. The apps-monitoring job is the
-- single refresher of these MVs, so none carries a SCHEDULE. The first two
-- SELECTs match sql/governance/06_app_activity_daily_mvs.sql (rolling 90-day
-- window, same columns); app_access_activity_daily is bundle-only. With a
-- non-empty prefix this file never touches the unprefixed MVs that the
-- admin-insights app reads; those refresh themselves with SCHEDULE EVERY 1 DAY.
-- CREATE OR REPLACE applies definition changes to existing MVs and recomputes
-- them synchronously (system.access.audit is not a Delta source, so every
-- refresh is a full recompute anyway), so there is no separate REFRESH.
-- :catalog, :schema, and :name_prefix come from the job parameters.
-- CREATE/ALTER MATERIALIZED VIEW do not accept IDENTIFIER(), so names are
-- built as strings and run with EXECUTE IMMEDIATE. All three parameters are
-- validated first, so they cannot inject SQL: catalog and schema must match
-- ^[A-Za-z0-9_]+$, the prefix ^[A-Za-z0-9_]*$ (empty allowed). The check
-- strips allowed characters and requires nothing left, because RLIKE's $ also
-- matches before a trailing newline. NULL is rejected explicitly, because a
-- NULL marker makes the character check NULL rather than TRUE.
BEGIN
  DECLARE obo_mv STRING;
  DECLARE config_mv STRING;
  DECLARE access_mv STRING;

  IF :catalog IS NULL OR :catalog = '' OR regexp_replace(:catalog, '[A-Za-z0-9_]', '') <> ''
    OR :schema IS NULL OR :schema = '' OR regexp_replace(:schema, '[A-Za-z0-9_]', '') <> '' THEN
    SIGNAL SQLSTATE '22023' SET MESSAGE_TEXT = 'catalog and schema job parameters must match ^[A-Za-z0-9_]+$';
  END IF;
  IF :name_prefix IS NULL OR regexp_replace(:name_prefix, '[A-Za-z0-9_]', '') <> '' THEN
    SIGNAL SQLSTATE '22023' SET MESSAGE_TEXT = 'name_prefix job parameter must match ^[A-Za-z0-9_]*$';
  END IF;

  SET obo_mv = '`' || :catalog || '`.`' || :schema || '`.' || :name_prefix || 'app_obo_activity_daily';
  SET config_mv = '`' || :catalog || '`.`' || :schema || '`.' || :name_prefix || 'app_config_events_daily';
  SET access_mv = '`' || :catalog || '`.`' || :schema || '`.' || :name_prefix || 'app_access_activity_daily';

  -- 1. Create or replace (also recomputes an existing MV).
  EXECUTE IMMEDIATE 'CREATE OR REPLACE MATERIALIZED VIEW ' || obo_mv || "
COMMENT 'Databricks Apps on-behalf-of (user authorization) facts from the last 90 days of system.access.audit, refreshed daily by the apps-monitoring job. Grain: activity date, workspace, acting resource, user, service, action. Only Databricks Apps rows: acting_resource is the full path accounts/<account>/oauth2/custom-app-integrations/<oauth2_app_client_id>, and oauth2_app_client_id is its last segment (match it to the Apps API oauth2_app_client_id). Most rows have workspace_id 0, so do not match on workspace. user_email can be the app service principal application ID rather than a human.'
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  identity_metadata.acting_resource AS acting_resource,
  user_identity.email AS user_email,
  service_name,
  action_name,
  count(*) AS event_count,
  regexp_extract(identity_metadata.acting_resource, '([^/]+)$', 1) AS oauth2_app_client_id
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND identity_metadata.acting_resource LIKE 'accounts/%/oauth2/custom-app-integrations/%'
GROUP BY
  event_date,
  workspace_id,
  identity_metadata.acting_resource,
  user_identity.email,
  service_name,
  action_name";

  EXECUTE IMMEDIATE 'CREATE OR REPLACE MATERIALIZED VIEW ' || config_mv || "
COMMENT 'Latest createApp/updateApp payload per app for the last 90 days, refreshed daily by the apps-monitoring job. Used to flag apps that do not declare user_api_scopes (possible app-SP-only authorization).'
AS
SELECT
  event_date AS activity_date,
  event_time,
  workspace_id,
  action_name,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) AS actor,
  get_json_object(element_at(request_params, 'app'), '$.name') AS app_name,
  get_json_object(element_at(request_params, 'app'), '$.user_api_scopes') AS user_api_scopes
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND action_name IN ('createApp', 'updateApp')
  AND get_json_object(element_at(request_params, 'app'), '$.name') IS NOT NULL
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY event_date, workspace_id, get_json_object(element_at(request_params, 'app'), '$.name')
  ORDER BY event_time DESC
) = 1";

  EXECUTE IMMEDIATE 'CREATE OR REPLACE MATERIALIZED VIEW ' || access_mv || "
COMMENT 'Databricks Apps access signals from the last 90 days of system.access.audit, refreshed daily by the apps-monitoring job. Grain: activity date, workspace, OAuth client, user, signal. login = successful workspace mintOAuthAuthorizationCode (a browser sign-in to the app), oauth2_app_client_id = request client_id. consent = account-level createOrUpdateOAuthAppUserConsentEvent (workspace_id is not the app workspace), oauth2_app_client_id = integration_id. sp_activity = actions by a service principal (user_email is its application ID, oauth2_app_client_id is NULL), excluding token/auth and source-export actions that every running app emits.'
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  CASE action_name
    WHEN 'mintOAuthAuthorizationCode' THEN request_params['client_id']
    WHEN 'createOrUpdateOAuthAppUserConsentEvent' THEN request_params['integration_id']
  END AS oauth2_app_client_id,
  user_identity.email AS user_email,
  CASE action_name
    WHEN 'mintOAuthAuthorizationCode' THEN 'login'
    WHEN 'createOrUpdateOAuthAppUserConsentEvent' THEN 'consent'
    ELSE 'sp_activity'
  END AS signal,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND (
    (service_name = 'workspace' AND action_name = 'mintOAuthAuthorizationCode'
      AND response.status_code = 200 AND request_params['client_id'] IS NOT NULL)
    OR (service_name = 'oauth2' AND action_name = 'createOrUpdateOAuthAppUserConsentEvent'
      AND response.status_code = 200 AND request_params['integration_id'] IS NOT NULL)
    OR (user_identity.email RLIKE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND action_name NOT IN (
        'mintOAuthAuthorizationCode', 'createOrUpdateOAuthAppUserConsentEvent',
        'oidcTokenAuthorization', 'workspaceInHouseOAuthClientAuthentication',
        'mintOAuthToken', 'tokenLogin', 'workspaceExport'
      ))
  )
GROUP BY
  event_date,
  workspace_id,
  CASE action_name
    WHEN 'mintOAuthAuthorizationCode' THEN request_params['client_id']
    WHEN 'createOrUpdateOAuthAppUserConsentEvent' THEN request_params['integration_id']
  END,
  user_identity.email,
  CASE action_name
    WHEN 'mintOAuthAuthorizationCode' THEN 'login'
    WHEN 'createOrUpdateOAuthAppUserConsentEvent' THEN 'consent'
    ELSE 'sp_activity'
  END";

  -- 2. Drop any SCHEDULE someone added outside the bundle. DROP SCHEDULE fails with
  --    DROP_SCHEDULE_SCHEDULE_DOES_NOT_EXIST when there is none (its SQLSTATE
  --    is the generic 42000), so the handler matches that condition identifier
  --    and re-raises anything else.
  BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
      DECLARE cond STRING;
      GET DIAGNOSTICS CONDITION 1 cond = CONDITION_IDENTIFIER;
      IF cond IS DISTINCT FROM 'DROP_SCHEDULE_SCHEDULE_DOES_NOT_EXIST' THEN RESIGNAL; END IF;
    END;
    EXECUTE IMMEDIATE 'ALTER MATERIALIZED VIEW ' || obo_mv || ' DROP SCHEDULE';
  END;

  BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
      DECLARE cond STRING;
      GET DIAGNOSTICS CONDITION 1 cond = CONDITION_IDENTIFIER;
      IF cond IS DISTINCT FROM 'DROP_SCHEDULE_SCHEDULE_DOES_NOT_EXIST' THEN RESIGNAL; END IF;
    END;
    EXECUTE IMMEDIATE 'ALTER MATERIALIZED VIEW ' || config_mv || ' DROP SCHEDULE';
  END;

  BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
      DECLARE cond STRING;
      GET DIAGNOSTICS CONDITION 1 cond = CONDITION_IDENTIFIER;
      IF cond IS DISTINCT FROM 'DROP_SCHEDULE_SCHEDULE_DOES_NOT_EXIST' THEN RESIGNAL; END IF;
    END;
    EXECUTE IMMEDIATE 'ALTER MATERIALIZED VIEW ' || access_mv || ' DROP SCHEDULE';
  END;
END

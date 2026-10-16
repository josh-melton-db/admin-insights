-- Ensure, unschedule, and refresh this bundle's Databricks Apps materialized
-- views, <name_prefix>app_obo_activity_daily and <name_prefix>app_config_events_daily.
-- The apps-monitoring job is the single refresher of these MVs, so neither
-- carries a SCHEDULE. The SELECTs match sql/governance/06_app_activity_daily_mvs.sql
-- (rolling 90-day window, same columns). With a non-empty prefix this file
-- never touches the unprefixed MVs that the admin-insights app reads; those
-- refresh themselves with SCHEDULE EVERY 1 DAY.
-- :catalog, :schema, and :name_prefix come from the job parameters.
-- ALTER/REFRESH MATERIALIZED VIEW do not accept IDENTIFIER(), so names are
-- built as strings and run with EXECUTE IMMEDIATE. All three parameters are
-- validated first, so they cannot inject SQL: catalog and schema must match
-- ^[A-Za-z0-9_]+$, the prefix ^[A-Za-z0-9_]*$ (empty allowed). The check
-- strips allowed characters and requires nothing left, because RLIKE's $ also
-- matches before a trailing newline. NULL is rejected explicitly, because a
-- NULL marker makes the character check NULL rather than TRUE.
BEGIN
  DECLARE obo_mv STRING;
  DECLARE config_mv STRING;

  IF :catalog IS NULL OR :catalog = '' OR regexp_replace(:catalog, '[A-Za-z0-9_]', '') <> ''
    OR :schema IS NULL OR :schema = '' OR regexp_replace(:schema, '[A-Za-z0-9_]', '') <> '' THEN
    SIGNAL SQLSTATE '22023' SET MESSAGE_TEXT = 'catalog and schema job parameters must match ^[A-Za-z0-9_]+$';
  END IF;
  IF :name_prefix IS NULL OR regexp_replace(:name_prefix, '[A-Za-z0-9_]', '') <> '' THEN
    SIGNAL SQLSTATE '22023' SET MESSAGE_TEXT = 'name_prefix job parameter must match ^[A-Za-z0-9_]*$';
  END IF;

  SET obo_mv = '`' || :catalog || '`.`' || :schema || '`.' || :name_prefix || 'app_obo_activity_daily';
  SET config_mv = '`' || :catalog || '`.`' || :schema || '`.' || :name_prefix || 'app_config_events_daily';

  -- 1. Create if missing (no-op when the MV already exists).
  EXECUTE IMMEDIATE 'CREATE MATERIALIZED VIEW IF NOT EXISTS ' || obo_mv || "
COMMENT 'Databricks Apps on-behalf-of (user authorization) facts from the last 90 days of system.access.audit, refreshed daily by the apps-monitoring job. Grain: activity date, workspace, acting resource, user, service, action. acting_resource is the OAuth app ID or name from identity_metadata.'
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  identity_metadata.acting_resource AS acting_resource,
  user_identity.email AS user_email,
  service_name,
  action_name,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND identity_metadata.acting_resource IS NOT NULL
GROUP BY
  event_date,
  workspace_id,
  identity_metadata.acting_resource,
  user_identity.email,
  service_name,
  action_name";

  EXECUTE IMMEDIATE 'CREATE MATERIALIZED VIEW IF NOT EXISTS ' || config_mv || "
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

  -- 2. Drop any existing SCHEDULE. DROP SCHEDULE fails with
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

  -- 3. Refresh (synchronous; the task fails if a refresh fails).
  EXECUTE IMMEDIATE 'REFRESH MATERIALIZED VIEW ' || obo_mv;
  EXECUTE IMMEDIATE 'REFRESH MATERIALIZED VIEW ' || config_mv;
END

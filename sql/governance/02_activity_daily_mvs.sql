-- system.access.audit is not a Delta source, so incremental refresh is not
-- eligible. These views use a bounded rolling 90-day daily full refresh.
-- AppKit queries read these MVs rather than scanning audit live.

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.login_activity_daily
COMMENT 'Daily-refreshing login and authentication facts from the last 90 days of system.access.audit. Grain: activity date, workspace, actor, user agent, action.'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) AS actor,
  user_agent,
  action_name,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND (
    lower(action_name) LIKE '%login%'
    OR action_name IN ('oidcBrowserLogin', 'tokenLogin', 'samlLogin', 'jwtLogin', 'certLogin')
  )
GROUP BY event_date, workspace_id, actor, user_agent, action_name;

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.object_access_daily
COMMENT 'Daily-refreshing Unity Catalog object-access facts from the last 90 days. Grain: activity date, workspace, actor, action, securable.'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) AS actor,
  service_name,
  action_name,
  coalesce(
    element_at(request_params, 'full_name_arg'),
    element_at(request_params, 'name'),
    element_at(request_params, 'table_full_name'),
    element_at(request_params, 'securable_full_name')
  ) AS securable_name,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND service_name IN ('unityCatalog', 'databrickssql')
  AND action_name IN (
    'generateTemporaryTableCredential',
    'generateTemporaryPathCredential',
    'generateTemporaryVolumeCredential',
    'getTable',
    'getSchema',
    'getCatalog',
    'commandSubmit',
    'commandFinish'
  )
GROUP BY event_date, workspace_id, actor, service_name, action_name, securable_name;

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.schema_creation_daily
COMMENT 'Daily-refreshing schema, table, catalog, and volume creation facts from the last 90 days.'
SCHEDULE EVERY 1 DAY
AS
SELECT
  event_date AS activity_date,
  workspace_id,
  coalesce(user_identity.email, identity_metadata.run_as, identity_metadata.run_by) AS actor,
  action_name,
  coalesce(
    element_at(request_params, 'full_name_arg'),
    element_at(request_params, 'name'),
    element_at(request_params, 'schema_full_name')
  ) AS securable_name,
  count(*) AS event_count
FROM system.access.audit
WHERE event_date >= date_sub(current_date(), 90)
  AND service_name = 'unityCatalog'
  AND action_name IN ('createSchema', 'createTable', 'createCatalog', 'createVolume', 'createFunction')
GROUP BY event_date, workspace_id, actor, action_name, securable_name;

CREATE OR REPLACE MATERIALIZED VIEW demos.admin_insights.native_access_activity_daily
COMMENT 'Daily-refreshing, normalized native Unity Catalog request-for-access event fact. A batch request can emit multiple rows, one per requested principal, securable, and permission.'
SCHEDULE EVERY 1 DAY
AS
WITH request_for_access_events AS (
  SELECT
    event_time,
    event_date,
    event_id,
    request_id,
    workspace_id,
    coalesce(user_identity.email, identity_metadata.run_by, identity_metadata.run_as) AS requester,
    action_name,
    request_params,
    response.status_code AS response_status_code,
    response.result AS response_result,
    CASE
      WHEN action_name IN ('batchCreateAccessRequests', 'requestAccess')
        THEN 'access_request_submitted'
      WHEN action_name LIKE '%DestinationStatus%'
        THEN 'destination_status'
      WHEN action_name LIKE '%Destination%'
        THEN 'destination_configuration'
      ELSE 'request_for_access_administrative'
    END AS event_category
  FROM system.access.audit
  WHERE service_name = 'request-for-access'
    AND event_date >= date_sub(current_date(), 90)
),
batch_request_rows AS (
  SELECT
    event_time,
    event_date,
    event_id,
    request_id,
    workspace_id,
    requester,
    action_name,
    event_category,
    requested_item.behalf_of.id AS on_behalf_of_subject,
    requested_permission.securable.full_name AS securable_name,
    requested_privilege AS privilege,
    CAST(NULL AS STRING) AS destination_status,
    response_status_code
  FROM request_for_access_events
  LATERAL VIEW OUTER explode(
    from_json(
      element_at(request_params, 'requests'),
      'array<struct<behalf_of:struct<id:string,principal_type:string>,securable_permissions:array<struct<securable:struct<type:string,full_name:string>,permissions:array<string>>>>>'
    )
  ) batch_item AS requested_item
  LATERAL VIEW OUTER explode(requested_item.securable_permissions) permission_item AS requested_permission
  LATERAL VIEW OUTER explode(requested_permission.permissions) privilege_item AS requested_privilege
  WHERE action_name = 'batchCreateAccessRequests'
),
non_batch_rows AS (
  SELECT
    event_time,
    event_date,
    event_id,
    request_id,
    workspace_id,
    requester,
    action_name,
    event_category,
    coalesce(
      element_at(request_params, 'on_behalf_of'),
      element_at(request_params, 'onBehalfOf'),
      element_at(request_params, 'principal'),
      get_json_object(element_at(request_params, 'behalf_of'), '$.id'),
      get_json_object(element_at(request_params, 'request'), '$.behalf_of.id')
    ) AS on_behalf_of_subject,
    coalesce(
      element_at(request_params, 'securable_name'),
      element_at(request_params, 'securableName'),
      element_at(request_params, 'full_name'),
      element_at(request_params, 'resource_name'),
      get_json_object(element_at(request_params, 'securable'), '$.full_name'),
      get_json_object(element_at(request_params, 'request'), '$.securable.full_name')
    ) AS securable_name,
    coalesce(
      element_at(request_params, 'privilege'),
      element_at(request_params, 'privilege_type'),
      element_at(request_params, 'privilegeType'),
      get_json_object(element_at(request_params, 'permissions'), '$[0]'),
      get_json_object(element_at(request_params, 'request'), '$.permissions[0]')
    ) AS privilege,
    coalesce(
      element_at(request_params, 'destination_status'),
      element_at(request_params, 'destinationStatus'),
      element_at(request_params, 'status'),
      get_json_object(response_result, '$.overall_status'),
      get_json_object(response_result, '$.status')
    ) AS destination_status,
    response_status_code
  FROM request_for_access_events
  WHERE action_name <> 'batchCreateAccessRequests'
)
SELECT
  event_time,
  event_date AS activity_date,
  'native_request_for_access' AS request_source,
  event_id,
  request_id,
  workspace_id,
  event_category,
  action_name,
  requester,
  on_behalf_of_subject,
  securable_name,
  privilege,
  destination_status,
  response_status_code
FROM batch_request_rows
UNION ALL
SELECT
  event_time,
  event_date AS activity_date,
  'native_request_for_access' AS request_source,
  event_id,
  request_id,
  workspace_id,
  event_category,
  action_name,
  requester,
  on_behalf_of_subject,
  securable_name,
  privilege,
  destination_status,
  response_status_code
FROM non_batch_rows;

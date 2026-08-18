-- Executes on behalf of the signed-in user.
-- Reads the governed 90-day daily MV. Do not point this query at system.access.audit.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param actionFilter STRING
-- @param limit INT
SELECT
  sha2(
    concat_ws(
      '|',
      event_id,
      coalesce(on_behalf_of_subject, ''),
      coalesce(securable_name, ''),
      coalesce(privilege, ''),
      coalesce(destination_status, '')
    ),
    256
  ) AS normalized_row_id,
  event_time,
  activity_date,
  workspace_id,
  event_id,
  request_id,
  requester,
  action_name,
  event_category,
  securable_name,
  privilege,
  on_behalf_of_subject,
  destination_status,
  response_status_code
FROM demos.admin_insights.native_access_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  AND (:actionFilter = '' OR action_name = :actionFilter)
ORDER BY event_time DESC, normalized_row_id
LIMIT :limit;

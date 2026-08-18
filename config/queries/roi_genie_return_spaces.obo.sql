-- Executes on behalf of the signed-in user.
-- Genie spaces by conversation activity (return). Open the space to inspect usage.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
SELECT
  workspace_id,
  coalesce(space_id, 'unknown') AS space_id,
  coalesce(sum(CASE
    WHEN action_name IN ('genieStartConversationMessage', 'genieCreateConversationMessage')
      THEN event_count
  END), 0) AS message_events,
  count(DISTINCT CASE WHEN actor LIKE '%@%' THEN actor END) AS active_users,
  coalesce(sum(CASE WHEN action_name = 'updateConversationMessageFeedback' THEN event_count END), 0) AS feedback_events,
  coalesce(sum(CASE WHEN action_name = 'createConversationMessageComment' THEN event_count END), 0) AS review_requests
FROM demos.admin_insights.genie_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY workspace_id, coalesce(space_id, 'unknown')
ORDER BY message_events DESC, active_users DESC
LIMIT :limit;

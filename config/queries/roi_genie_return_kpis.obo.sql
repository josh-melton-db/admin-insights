-- Executes on behalf of the signed-in user.
-- Genie interaction (return) from the 90-day aibiGenie audit MV.
-- Do not scan system.access.audit live.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  coalesce(sum(CASE
    WHEN action_name IN ('genieStartConversationMessage', 'genieCreateConversationMessage')
      THEN event_count
  END), 0) AS message_events,
  coalesce(sum(CASE WHEN action_name = 'genieStartConversationMessage' THEN event_count END), 0) AS conversation_starts,
  coalesce(sum(CASE WHEN action_name = 'updateConversationMessageFeedback' THEN event_count END), 0) AS feedback_events,
  coalesce(sum(CASE WHEN action_name = 'createConversationMessageComment' THEN event_count END), 0) AS review_requests,
  count(DISTINCT CASE WHEN actor LIKE '%@%' THEN actor END) AS active_users,
  count(DISTINCT space_id) AS space_count,
  coalesce(sum(CASE WHEN coalesce(response_status_code, 200) >= 500 THEN event_count END), 0) AS error_5xx_events,
  current_timestamp() AS as_of,
  'demos.admin_insights.genie_activity_daily' AS metric_source
FROM demos.admin_insights.genie_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId);

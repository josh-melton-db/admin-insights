-- Executes on behalf of the signed-in user.
-- Daily Genie conversation messages from the aibiGenie audit MV.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  activity_date,
  coalesce(sum(CASE
    WHEN action_name IN ('genieStartConversationMessage', 'genieCreateConversationMessage')
      THEN event_count
  END), 0) AS message_events,
  count(DISTINCT CASE WHEN actor LIKE '%@%' THEN actor END) AS active_users,
  coalesce(sum(CASE WHEN action_name = 'updateConversationMessageFeedback' THEN event_count END), 0) AS feedback_events
FROM demos.admin_insights.genie_activity_daily
WHERE activity_date >= CAST(:startDate AS DATE)
  AND activity_date <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY activity_date
ORDER BY activity_date;

-- Executes on behalf of the signed-in user.
-- Untagged jobs rolled up by creator so the UI can drill into one owner.
-- @param workspaceScope STRING
-- @param creatorFilter STRING
-- @param limit INT
SELECT
  j.workspace_id,
  coalesce(j.creator_user_name, 'unknown') AS creator_user_name,
  count(*) AS job_count,
  count(CASE WHEN j.paused THEN 1 END) AS paused_job_count,
  max(t.period_end_time) AS last_run_time
FROM system.lakeflow.jobs j
LEFT JOIN system.lakeflow.job_run_timeline t
  ON j.workspace_id = t.workspace_id
  AND j.job_id = t.job_id
WHERE j.delete_time IS NULL
  AND (j.tags IS NULL OR size(j.tags) = 0)
  AND (:workspaceScope = 'all' OR j.workspace_id = :workspaceId)
  AND (
    :creatorFilter = ''
    OR j.creator_user_name = :creatorFilter
    OR (:creatorFilter = 'unknown' AND j.creator_user_name IS NULL)
  )
GROUP BY j.workspace_id, coalesce(j.creator_user_name, 'unknown')
ORDER BY job_count DESC, creator_user_name
LIMIT :limit;

-- Executes on behalf of the signed-in user.
-- @param workspaceScope STRING
-- @param nameFilter STRING
-- @param creatorFilter STRING
-- @param pausedFilter STRING
-- @param limit INT
SELECT
  j.workspace_id,
  j.job_id,
  j.name,
  j.creator_user_name,
  j.create_time,
  j.paused,
  size(j.tags) AS tag_count,
  max(t.period_end_time) AS last_run_time
FROM system.lakeflow.jobs j
LEFT JOIN system.lakeflow.job_run_timeline t
  ON j.workspace_id = t.workspace_id
  AND j.job_id = t.job_id
WHERE j.delete_time IS NULL
  AND (j.tags IS NULL OR size(j.tags) = 0)
  AND (:workspaceScope = 'all' OR j.workspace_id = :workspaceId)
  AND (:nameFilter = '' OR lower(j.name) LIKE lower(:nameFilter))
  AND (
    :creatorFilter = ''
    OR j.creator_user_name = :creatorFilter
    OR (:creatorFilter = 'unknown' AND j.creator_user_name IS NULL)
  )
  AND (
    :pausedFilter = 'all'
    OR (:pausedFilter = 'true' AND j.paused)
    OR (:pausedFilter = 'false' AND NOT coalesce(j.paused, false))
  )
GROUP BY j.workspace_id, j.job_id, j.name, j.creator_user_name, j.create_time, j.paused, size(j.tags)
ORDER BY last_run_time DESC NULLS LAST, j.create_time DESC
LIMIT :limit;

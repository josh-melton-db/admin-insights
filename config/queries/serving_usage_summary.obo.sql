-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
SELECT
  served_entity_id,
  count(*) AS request_count,
  coalesce(sum(input_token_count), 0) AS input_tokens,
  coalesce(sum(output_token_count), 0) AS output_tokens,
  sum(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
  max(request_time) AS last_request_time
FROM system.serving.endpoint_usage
WHERE DATE(request_time) >= CAST(:startDate AS DATE)
  AND DATE(request_time) <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY served_entity_id
ORDER BY request_count DESC
LIMIT :limit;

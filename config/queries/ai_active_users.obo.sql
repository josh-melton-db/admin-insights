-- Executes on behalf of the signed-in user.
-- Requesters with the most model-serving traffic. Governance Hub AI "active users".
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
SELECT
  requester,
  CASE
    WHEN requester LIKE '%@%' THEN 'user'
    WHEN requester RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN 'service_principal'
    ELSE 'other'
  END AS requester_kind,
  count(*) AS request_count,
  count(DISTINCT served_entity_id) AS model_count,
  coalesce(sum(input_token_count), 0) AS input_tokens,
  coalesce(sum(output_token_count), 0) AS output_tokens,
  max(request_time) AS last_request_time
FROM system.serving.endpoint_usage
WHERE DATE(request_time) >= CAST(:startDate AS DATE)
  AND DATE(request_time) <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY
  requester,
  CASE
    WHEN requester LIKE '%@%' THEN 'user'
    WHEN requester RLIKE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN 'service_principal'
    ELSE 'other'
  END
ORDER BY request_count DESC
LIMIT :limit;

-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
SELECT
  DATE(event_time) AS usage_date,
  coalesce(service_type, 'model') AS service_type,
  count(*) AS request_count,
  coalesce(sum(input_tokens), 0) AS input_tokens,
  coalesce(sum(output_tokens), 0) AS output_tokens,
  sum(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
  sum(CASE WHEN status_code IN (429, 402) THEN 1 ELSE 0 END) AS rate_or_budget_errors
FROM system.ai_gateway.usage
WHERE DATE(event_time) >= CAST(:startDate AS DATE)
  AND DATE(event_time) <= CAST(:endDate AS DATE)
  AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
GROUP BY DATE(event_time), coalesce(service_type, 'model')
ORDER BY usage_date, service_type;

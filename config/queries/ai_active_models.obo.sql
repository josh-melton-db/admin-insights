-- Executes on behalf of the signed-in user.
-- Most-requested serving entities in the window. Governance Hub AI "active models".
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH usage AS (
  SELECT
    u.workspace_id,
    u.served_entity_id,
    count(*) AS request_count,
    count(DISTINCT u.requester) AS requester_count,
    coalesce(sum(u.input_token_count), 0) AS input_tokens,
    coalesce(sum(u.output_token_count), 0) AS output_tokens,
    max(u.request_time) AS last_request_time
  FROM system.serving.endpoint_usage u
  WHERE DATE(u.request_time) >= CAST(:startDate AS DATE)
    AND DATE(u.request_time) <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY u.workspace_id, u.served_entity_id
),
latest_entities AS (
  SELECT
    workspace_id,
    endpoint_id,
    endpoint_name,
    served_entity_id,
    served_entity_name,
    entity_type,
    entity_name,
    custom_model_config.min_concurrency AS custom_min_concurrency,
    feature_spec_config.min_concurrency AS feature_min_concurrency,
    foundation_model_config.min_provisioned_throughput AS foundation_min_throughput
  FROM system.serving.served_entities
  WHERE endpoint_delete_time IS NULL
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY workspace_id, served_entity_id
    ORDER BY change_time DESC
  ) = 1
)
SELECT
  u.workspace_id,
  coalesce(e.endpoint_name, u.served_entity_id) AS endpoint_name,
  e.endpoint_id,
  coalesce(e.entity_name, e.served_entity_name, u.served_entity_id) AS model_name,
  e.entity_type,
  CASE
    WHEN coalesce(e.custom_min_concurrency, e.feature_min_concurrency) > 0
      OR coalesce(e.foundation_min_throughput, 0) > 0
      THEN 'does_not_scale_to_zero'
    WHEN e.custom_min_concurrency = 0
      OR e.feature_min_concurrency = 0
      OR e.foundation_min_throughput = 0
      THEN 'scales_to_zero'
    ELSE 'unknown'
  END AS scale_to_zero_band,
  u.request_count,
  u.requester_count,
  u.input_tokens,
  u.output_tokens,
  u.last_request_time
FROM usage u
LEFT JOIN latest_entities e
  ON u.workspace_id = e.workspace_id
  AND u.served_entity_id = e.served_entity_id
ORDER BY u.request_count DESC
LIMIT :limit;

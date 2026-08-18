-- Executes on behalf of the signed-in user.
-- Vector Search index queries (return) with attributed spend when the index
-- can be joined to a billed endpoint (createVectorIndex in the 90-day MV, or
-- Knowledge Assistant ka_{prefix} vs-endpoint naming). Do not scan audit live.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH queries AS (
  SELECT
    workspace_id,
    resource_name AS index_name,
    regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1) AS ka_prefix,
    CASE
      WHEN resource_name LIKE '%_examples_index%' THEN 'examples_index'
      WHEN regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1) <> '' THEN 'knowledge_assistant'
      ELSE 'vector_index'
    END AS index_kind,
    coalesce(sum(event_count), 0) AS query_count
  FROM demos.admin_insights.ai_return_activity_daily
  WHERE activity_date >= CAST(:startDate AS DATE)
    AND activity_date <= CAST(:endDate AS DATE)
    AND action_name = 'queryVectorIndex'
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  GROUP BY
    workspace_id,
    resource_name,
    regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1)
),
index_endpoints AS (
  SELECT
    workspace_id,
    resource_name AS index_name,
    max(endpoint_name) AS endpoint_name
  FROM demos.admin_insights.ai_return_activity_daily
  WHERE action_name = 'createVectorIndex'
    AND endpoint_name IS NOT NULL
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  GROUP BY workspace_id, resource_name
),
vs_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.endpoint_name,
    regexp_extract(lower(u.endpoint_name), '^ka-([0-9a-f]{8})', 1) AS ka_prefix,
    u.dbus
  FROM (
    SELECT
      account_id,
      workspace_id,
      sku_name,
      cloud,
      usage_unit,
      usage_date,
      coalesce(usage_metadata.endpoint_name, usage_metadata.endpoint_id, 'unknown') AS endpoint_name,
      sum(usage_quantity) AS dbus
    FROM system.billing.usage
    WHERE usage_date >= CAST(:startDate AS DATE)
      AND usage_date <= CAST(:endDate AS DATE)
      AND billing_origin_product = 'VECTOR_SEARCH'
      AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
    GROUP BY
      account_id,
      workspace_id,
      sku_name,
      cloud,
      usage_unit,
      usage_date,
      coalesce(usage_metadata.endpoint_name, usage_metadata.endpoint_id, 'unknown')
  ) u
),
vs_cost AS (
  SELECT
    u.workspace_id,
    u.endpoint_name,
    u.ka_prefix,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM vs_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.endpoint_name, u.ka_prefix
)
SELECT
  q.workspace_id,
  q.index_name,
  q.index_kind,
  q.ka_prefix,
  q.query_count,
  coalesce(e.endpoint_name, k.endpoint_name) AS endpoint_name,
  coalesce(e_cost.list_cost, k.list_cost) AS list_cost,
  CASE
    WHEN q.query_count = 0 OR coalesce(e_cost.list_cost, k.list_cost) IS NULL THEN NULL
    ELSE coalesce(e_cost.list_cost, k.list_cost) / q.query_count
  END AS cost_per_query,
  'ai_return_activity_daily + system.billing.usage' AS metric_source
FROM queries q
LEFT JOIN index_endpoints e
  ON q.workspace_id = e.workspace_id
  AND q.index_name = e.index_name
LEFT JOIN vs_cost e_cost
  ON e.workspace_id = e_cost.workspace_id
  AND e.endpoint_name = e_cost.endpoint_name
LEFT JOIN vs_cost k
  ON q.ka_prefix <> ''
  AND q.workspace_id = k.workspace_id
  AND q.ka_prefix = k.ka_prefix
  AND e.endpoint_name IS NULL
ORDER BY q.query_count DESC, coalesce(e_cost.list_cost, k.list_cost) DESC NULLS LAST
LIMIT :limit;

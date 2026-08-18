-- Executes on behalf of the signed-in user.
-- Knowledge Assistant attributed spend (AGENT_BRICKS) with questions answered.
-- Questions are Vector Search queryVectorIndex events on ka_{prefix}_ indexes,
-- excluding examples indexes. Do not scan system.access.audit live.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH billed_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.agent_bricks_id AS agent_id,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown') AS endpoint_name,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.billing_origin_product = 'AGENT_BRICKS'
    AND u.usage_metadata.agent_bricks_id IS NOT NULL
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.agent_bricks_id,
    coalesce(u.usage_metadata.endpoint_name, u.usage_metadata.endpoint_id, 'unknown')
),
billed AS (
  SELECT
    u.workspace_id,
    u.agent_id,
    u.endpoint_name,
    lower(substr(replace(u.agent_id, '-', ''), 1, 8)) AS ka_prefix,
    coalesce(sum(u.dbus), 0) AS dbus,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM billed_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.agent_id, u.endpoint_name
),
questions AS (
  SELECT
    workspace_id,
    regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1) AS ka_prefix,
    coalesce(sum(event_count), 0) AS question_count
  FROM demos.admin_insights.ai_return_activity_daily
  WHERE activity_date >= CAST(:startDate AS DATE)
    AND activity_date <= CAST(:endDate AS DATE)
    AND action_name = 'queryVectorIndex'
    AND resource_name NOT LIKE '%_examples_index%'
    AND regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1) <> ''
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  GROUP BY workspace_id, regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1)
)
SELECT
  b.workspace_id,
  b.agent_id,
  b.endpoint_name,
  b.ka_prefix,
  b.dbus,
  b.list_cost,
  coalesce(q.question_count, 0) AS question_count,
  CASE
    WHEN coalesce(q.question_count, 0) = 0 THEN NULL
    ELSE b.list_cost / q.question_count
  END AS cost_per_question,
  CASE WHEN coalesce(q.question_count, 0) = 0 THEN 'no_questions' ELSE 'has_questions' END AS usage_band,
  'system.billing.usage + ai_return_activity_daily' AS metric_source
FROM billed b
LEFT JOIN questions q
  ON b.workspace_id = q.workspace_id
  AND b.ka_prefix = q.ka_prefix
ORDER BY b.list_cost DESC
LIMIT :limit;

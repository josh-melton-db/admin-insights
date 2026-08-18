-- Executes on behalf of the signed-in user.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
WITH usage_daily AS (
  SELECT
    u.account_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.billing_origin_product, 'unknown') AS product,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.billing_origin_product, 'unknown')
),
serving_queries AS (
  SELECT count(*) AS return_count
  FROM system.serving.endpoint_usage u
  WHERE DATE(u.request_time) >= CAST(:startDate AS DATE)
    AND DATE(u.request_time) <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
),
index_queries AS (
  SELECT
    coalesce(sum(CASE
      WHEN resource_name NOT LIKE '%_examples_index%'
        AND regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1) <> ''
        THEN event_count
    END), 0) AS ka_question_count,
    coalesce(sum(event_count), 0) AS index_query_count
  FROM demos.admin_insights.ai_return_activity_daily
  WHERE activity_date >= CAST(:startDate AS DATE)
    AND activity_date <= CAST(:endDate AS DATE)
    AND action_name = 'queryVectorIndex'
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
),
genie_questions AS (
  SELECT coalesce(sum(CASE
    WHEN action_name IN ('genieStartConversationMessage', 'genieCreateConversationMessage')
      THEN event_count
  END), 0) AS question_count
  FROM demos.admin_insights.genie_activity_daily
  WHERE activity_date >= CAST(:startDate AS DATE)
    AND activity_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
)
SELECT
  u.product,
  coalesce(sum(u.dbus), 0) AS dbus,
  coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost,
  CASE
    WHEN u.product = 'MODEL_SERVING' THEN sq.return_count
    WHEN u.product = 'VECTOR_SEARCH' THEN iq.index_query_count
    WHEN u.product = 'AGENT_BRICKS' THEN iq.ka_question_count
    WHEN u.product = 'GENIE' THEN gq.question_count
    ELSE NULL
  END AS return_count,
  CASE
    WHEN u.product = 'MODEL_SERVING' THEN 'queries'
    WHEN u.product = 'VECTOR_SEARCH' THEN 'index_queries'
    WHEN u.product = 'AGENT_BRICKS' THEN 'questions'
    WHEN u.product = 'GENIE' THEN 'questions'
    ELSE 'none'
  END AS return_unit,
  CASE
    WHEN u.product = 'JOBS' THEN 'Downstream notebooks, dashboards, queries, pipelines, and jobs on tables these jobs wrote'
    WHEN coalesce(u.product, '') LIKE '%SQL%' THEN 'Warehouse queries — inspect idle warehouses'
    WHEN u.product = 'MODEL_SERVING' THEN 'Endpoint queries from serving.endpoint_usage'
    WHEN u.product = 'APPS' THEN 'User-authorization (OBO) actions and Insights viewers, not billing on/off'
    WHEN u.product = 'VECTOR_SEARCH' THEN 'Vector Search index queries (queryVectorIndex)'
    WHEN u.product = 'AGENT_BRICKS' THEN 'Knowledge Assistant questions — index queries on ka_{id}_ indexes'
    WHEN u.product = 'GENIE' THEN 'Genie conversation messages — user Genie One/Agents are Databricks-funded through 2027-01-31; Genie Code has 150 free DBUs per user per month'
    WHEN u.product IN ('DLT', 'LAKEFLOW', 'PIPELINE') THEN 'Pipeline outputs consumed by downstream data products'
    ELSE 'Attribute with tags or an existing usage policy so spend maps to a data product'
  END AS return_signal,
  CASE
    WHEN u.product = 'JOBS' THEN 'Open jobs below to inspect lineage or pause unused jobs'
    WHEN coalesce(u.product, '') LIKE '%SQL%' THEN 'Open SQL warehouses to stop idle compute'
    WHEN u.product = 'MODEL_SERVING' THEN 'Open serving with queries to inspect cost per query'
    WHEN u.product = 'APPS' THEN 'Open app Insights and confirm user API scopes'
    WHEN u.product = 'GENIE' THEN 'Open the Genie panel: $0 list on GENIE_FREE_USAGE is expected, not missing spend'
    WHEN u.product = 'VECTOR_SEARCH' THEN 'Open Vector Search index queries to inspect retrieval return'
    WHEN u.product = 'AGENT_BRICKS' THEN 'Open Knowledge Assistants: spend next to questions answered'
    ELSE 'Tag usage or attach an existing usage policy'
  END AS recommended_action
FROM usage_daily u
LEFT JOIN system.billing.list_prices p
  ON u.account_id = p.account_id
  AND u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND u.usage_unit = p.usage_unit
  AND u.usage_date >= CAST(p.price_start_time AS DATE)
  AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
CROSS JOIN serving_queries sq
CROSS JOIN index_queries iq
CROSS JOIN genie_questions gq
GROUP BY u.product, sq.return_count, iq.index_query_count, iq.ka_question_count, gq.question_count
ORDER BY list_cost DESC;

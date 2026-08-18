-- Executes on behalf of the signed-in user.
-- Highest-spend jobs, warehouses, serving, vector search, and apps in one list.
-- Each row includes a return signal or a recommended action — never spend alone.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH usage_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.billing_origin_product, 'unknown') AS product,
    CASE
      WHEN u.usage_metadata.job_id IS NOT NULL AND u.usage_metadata.job_id <> '' THEN 'job'
      WHEN u.billing_origin_product = 'VECTOR_SEARCH'
        AND u.usage_metadata.endpoint_name IS NOT NULL THEN 'vector_search'
      WHEN u.usage_metadata.endpoint_name IS NOT NULL THEN 'endpoint'
      WHEN u.usage_metadata.warehouse_id IS NOT NULL THEN 'warehouse'
      WHEN u.usage_metadata.app_name IS NOT NULL OR u.usage_metadata.app_id IS NOT NULL THEN 'app'
      WHEN u.usage_metadata.agent_bricks_id IS NOT NULL THEN 'agent'
      ELSE 'sku'
    END AS resource_kind,
    CASE
      WHEN u.usage_metadata.job_id IS NOT NULL AND u.usage_metadata.job_id <> ''
        THEN u.usage_metadata.job_id
      WHEN u.usage_metadata.endpoint_name IS NOT NULL
        THEN u.usage_metadata.endpoint_name
      WHEN u.usage_metadata.warehouse_id IS NOT NULL
        THEN u.usage_metadata.warehouse_id
      WHEN u.usage_metadata.app_name IS NOT NULL
        THEN u.usage_metadata.app_name
      WHEN u.usage_metadata.app_id IS NOT NULL
        THEN u.usage_metadata.app_id
      WHEN u.usage_metadata.agent_bricks_id IS NOT NULL
        THEN u.usage_metadata.agent_bricks_id
      ELSE u.sku_name
    END AS resource_id,
    CASE
      WHEN u.usage_metadata.job_id IS NOT NULL AND u.usage_metadata.job_id <> ''
        THEN coalesce(u.usage_metadata.job_name, u.usage_metadata.job_id)
      WHEN u.usage_metadata.endpoint_name IS NOT NULL
        THEN u.usage_metadata.endpoint_name
      WHEN u.usage_metadata.warehouse_id IS NOT NULL
        THEN concat('warehouse ', u.usage_metadata.warehouse_id)
      WHEN u.usage_metadata.app_name IS NOT NULL
        THEN u.usage_metadata.app_name
      WHEN u.usage_metadata.agent_bricks_id IS NOT NULL
        THEN u.usage_metadata.agent_bricks_id
      ELSE u.sku_name
    END AS resource_name,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND coalesce(u.usage_metadata.endpoint_name, '') NOT LIKE 'databricks-%'
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    coalesce(u.billing_origin_product, 'unknown'),
    CASE
      WHEN u.usage_metadata.job_id IS NOT NULL AND u.usage_metadata.job_id <> '' THEN 'job'
      WHEN u.billing_origin_product = 'VECTOR_SEARCH'
        AND u.usage_metadata.endpoint_name IS NOT NULL THEN 'vector_search'
      WHEN u.usage_metadata.endpoint_name IS NOT NULL THEN 'endpoint'
      WHEN u.usage_metadata.warehouse_id IS NOT NULL THEN 'warehouse'
      WHEN u.usage_metadata.app_name IS NOT NULL OR u.usage_metadata.app_id IS NOT NULL THEN 'app'
      WHEN u.usage_metadata.agent_bricks_id IS NOT NULL THEN 'agent'
      ELSE 'sku'
    END,
    CASE
      WHEN u.usage_metadata.job_id IS NOT NULL AND u.usage_metadata.job_id <> ''
        THEN u.usage_metadata.job_id
      WHEN u.usage_metadata.endpoint_name IS NOT NULL
        THEN u.usage_metadata.endpoint_name
      WHEN u.usage_metadata.warehouse_id IS NOT NULL
        THEN u.usage_metadata.warehouse_id
      WHEN u.usage_metadata.app_name IS NOT NULL
        THEN u.usage_metadata.app_name
      WHEN u.usage_metadata.app_id IS NOT NULL
        THEN u.usage_metadata.app_id
      WHEN u.usage_metadata.agent_bricks_id IS NOT NULL
        THEN u.usage_metadata.agent_bricks_id
      ELSE u.sku_name
    END,
    CASE
      WHEN u.usage_metadata.job_id IS NOT NULL AND u.usage_metadata.job_id <> ''
        THEN coalesce(u.usage_metadata.job_name, u.usage_metadata.job_id)
      WHEN u.usage_metadata.endpoint_name IS NOT NULL
        THEN u.usage_metadata.endpoint_name
      WHEN u.usage_metadata.warehouse_id IS NOT NULL
        THEN concat('warehouse ', u.usage_metadata.warehouse_id)
      WHEN u.usage_metadata.app_name IS NOT NULL
        THEN u.usage_metadata.app_name
      WHEN u.usage_metadata.agent_bricks_id IS NOT NULL
        THEN u.usage_metadata.agent_bricks_id
      ELSE u.sku_name
    END
),
priced AS (
  SELECT
    u.workspace_id,
    u.product,
    u.resource_kind,
    u.resource_id,
    u.resource_name,
    coalesce(sum(u.dbus), 0) AS dbus,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.product, u.resource_kind, u.resource_id, u.resource_name
),
latest_entities AS (
  SELECT
    workspace_id,
    endpoint_id,
    endpoint_name,
    served_entity_id
  FROM system.serving.served_entities
  WHERE endpoint_delete_time IS NULL
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY workspace_id, endpoint_id, served_entity_id
    ORDER BY change_time DESC
  ) = 1
),
serving_queries AS (
  SELECT
    e.workspace_id,
    e.endpoint_name,
    e.endpoint_id,
    count(*) AS query_count
  FROM system.serving.endpoint_usage u
  INNER JOIN latest_entities e
    ON u.workspace_id = e.workspace_id
    AND u.served_entity_id = e.served_entity_id
  WHERE DATE(u.request_time) >= CAST(:startDate AS DATE)
    AND DATE(u.request_time) <= CAST(:endDate AS DATE)
  GROUP BY e.workspace_id, e.endpoint_name, e.endpoint_id
),
index_queries AS (
  SELECT
    workspace_id,
    regexp_extract(lower(resource_name), 'ka_([0-9a-f]{8})_', 1) AS ka_prefix,
    coalesce(sum(event_count), 0) AS query_count
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
  r.workspace_id,
  r.product,
  r.resource_kind,
  r.resource_id,
  r.resource_name,
  r.dbus,
  r.list_cost,
  CASE
    WHEN r.resource_kind = 'endpoint' THEN coalesce(sq.query_count, 0)
    WHEN r.resource_kind = 'agent' THEN coalesce(kq.query_count, 0)
    WHEN r.resource_kind = 'vector_search' THEN coalesce(vq.query_count, 0)
    ELSE NULL
  END AS return_count,
  CASE
    WHEN r.resource_kind = 'endpoint' THEN 'queries'
    WHEN r.resource_kind = 'agent' THEN 'questions'
    WHEN r.resource_kind = 'vector_search' THEN 'index_queries'
    ELSE 'none'
  END AS return_unit,
  CASE
    WHEN r.resource_kind = 'job' THEN 'Open the job: downstream notebooks, dashboards, and queries on tables it wrote, or pause/tag if there is no return'
    WHEN r.resource_kind = 'endpoint' THEN 'Open the endpoint: confirm request traffic, then stop or delete if unused'
    WHEN r.resource_kind = 'vector_search'
      AND (lower(r.resource_id) LIKE 'ka-%' OR lower(r.resource_id) LIKE 'mas-%')
      THEN 'Open the Agent Bricks Vector Search endpoint — indexes are managed by the assistant or supervisor'
    WHEN r.resource_kind = 'vector_search' THEN 'Open Vector Search: delete endpoints with no indexes'
    WHEN r.resource_kind = 'warehouse' THEN 'Open the warehouse: stop idle SQL warehouses'
    WHEN r.resource_kind = 'app' THEN 'Open app Insights: confirm user-authorization actions, not just billing'
    WHEN r.resource_kind = 'agent' THEN 'Open the Knowledge Assistant endpoint: questions are index queries that answered users'
    WHEN r.product = 'GENIE' THEN 'Open the Genie panel: Databricks-funded GENIE_FREE_USAGE has $0 list; billed Code above 150 DBUs is investment'
    ELSE 'Tag this SKU or attach an existing usage policy so spend maps to a data product'
  END AS recommended_action
FROM priced r
LEFT JOIN serving_queries sq
  ON r.resource_kind = 'endpoint'
  AND r.workspace_id = sq.workspace_id
  AND r.resource_id = sq.endpoint_name
LEFT JOIN index_queries kq
  ON r.resource_kind = 'agent'
  AND r.workspace_id = kq.workspace_id
  AND kq.ka_prefix <> ''
  AND lower(substr(replace(r.resource_id, '-', ''), 1, 8)) = kq.ka_prefix
LEFT JOIN index_queries vq
  ON r.resource_kind = 'vector_search'
  AND r.workspace_id = vq.workspace_id
  AND vq.ka_prefix <> ''
  AND regexp_extract(lower(r.resource_id), '^ka-([0-9a-f]{8})', 1) = vq.ka_prefix
ORDER BY r.list_cost DESC
LIMIT :limit;

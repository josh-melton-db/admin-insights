-- Executes on behalf of the signed-in user.
-- Warehouse ROI: list-price spend vs query return (dashboards, Genie, jobs,
-- notebooks) plus queue / cold-start signals from query.history. Sizing bands
-- follow DBA Query Observability (queue proportion, wait at capacity, wait for
-- compute) without the cost-per-query MV.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH latest_warehouses AS (
  SELECT
    workspace_id,
    warehouse_id,
    warehouse_name,
    warehouse_type,
    warehouse_size,
    min_clusters,
    max_clusters,
    auto_stop_minutes,
    created_by
  FROM system.compute.warehouses
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY workspace_id, warehouse_id
    ORDER BY change_time DESC
  ) = 1
),
warehouse_usage_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.warehouse_id AS warehouse_id,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.usage_metadata.warehouse_id IS NOT NULL
    AND u.usage_metadata.warehouse_id <> ''
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.warehouse_id
),
warehouse_cost AS (
  SELECT
    u.workspace_id,
    u.warehouse_id,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM warehouse_usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.warehouse_id
),
query_stats AS (
  SELECT
    h.workspace_id,
    h.compute.warehouse_id AS warehouse_id,
    count(*) AS query_count,
    count(DISTINCT h.executed_by) AS distinct_users,
    count(
      DISTINCT CASE
        WHEN h.query_source.dashboard_id IS NOT NULL OR h.query_source.legacy_dashboard_id IS NOT NULL
          THEN h.statement_id
      END
    ) AS dashboard_queries,
    count(DISTINCT CASE WHEN h.query_source.genie_space_id IS NOT NULL THEN h.statement_id END) AS genie_queries,
    count(DISTINCT CASE WHEN h.query_source.job_info.job_id IS NOT NULL THEN h.statement_id END) AS job_queries,
    count(DISTINCT CASE WHEN h.query_source.notebook_id IS NOT NULL THEN h.statement_id END) AS notebook_queries,
    avg(try_divide(h.waiting_at_capacity_duration_ms, 1000)) AS avg_queue_sec,
    approx_percentile(try_divide(h.waiting_at_capacity_duration_ms, 1000), 0.95) AS p95_queue_sec,
    avg(try_divide(h.waiting_for_compute_duration_ms, 1000)) AS avg_wait_compute_sec,
    avg(try_divide(h.execution_duration_ms, 1000)) AS avg_exec_sec,
    avg(coalesce(try_divide(h.waiting_at_capacity_duration_ms, h.total_duration_ms), 0)) AS avg_queue_proportion
  FROM system.query.history h
  WHERE DATE(h.start_time) >= CAST(:startDate AS DATE)
    AND DATE(h.start_time) <= CAST(:endDate AS DATE)
    AND h.compute.warehouse_id IS NOT NULL
    AND h.compute.warehouse_id <> ''
    AND (:workspaceScope = 'all' OR h.workspace_id = :workspaceId)
  GROUP BY h.workspace_id, h.compute.warehouse_id
),
warehouse_runtime AS (
  SELECT
    workspace_id,
    warehouse_id,
    avg(cluster_count) AS avg_cluster_count,
    max(cluster_count) AS peak_cluster_count
  FROM system.compute.warehouse_events
  WHERE DATE(event_time) >= CAST(:startDate AS DATE)
    AND DATE(event_time) <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR workspace_id = :workspaceId)
  GROUP BY workspace_id, warehouse_id
),
keys AS (
  SELECT workspace_id, warehouse_id FROM warehouse_cost
  UNION
  SELECT workspace_id, warehouse_id FROM query_stats
)
SELECT
  k.workspace_id,
  k.warehouse_id,
  coalesce(w.warehouse_name, k.warehouse_id) AS warehouse_name,
  w.warehouse_type,
  w.warehouse_size,
  w.min_clusters,
  w.max_clusters,
  w.auto_stop_minutes,
  w.created_by,
  coalesce(q.query_count, 0) AS query_count,
  coalesce(q.distinct_users, 0) AS distinct_users,
  coalesce(q.dashboard_queries, 0) AS dashboard_queries,
  coalesce(q.genie_queries, 0) AS genie_queries,
  coalesce(q.job_queries, 0) AS job_queries,
  coalesce(q.notebook_queries, 0) AS notebook_queries,
  coalesce(q.avg_queue_sec, 0) AS avg_queue_sec,
  coalesce(q.p95_queue_sec, 0) AS p95_queue_sec,
  coalesce(q.avg_wait_compute_sec, 0) AS avg_wait_compute_sec,
  coalesce(q.avg_exec_sec, 0) AS avg_exec_sec,
  coalesce(q.avg_queue_proportion, 0) AS avg_queue_proportion,
  coalesce(r.avg_cluster_count, 0) AS avg_cluster_count,
  coalesce(r.peak_cluster_count, 0) AS peak_cluster_count,
  coalesce(c.list_cost, 0) AS list_cost,
  CASE
    WHEN coalesce(q.query_count, 0) = 0 AND coalesce(c.list_cost, 0) > 0 THEN 'spend_no_queries'
    WHEN coalesce(q.p95_queue_sec, 0) >= 5 OR coalesce(q.avg_queue_proportion, 0) >= 0.10 THEN 'undersized_queued'
    WHEN coalesce(w.min_clusters, 0) = 0 AND coalesce(q.avg_wait_compute_sec, 0) >= 10 THEN 'scaling_from_zero'
    WHEN coalesce(w.min_clusters, 0) >= 1
      AND coalesce(q.query_count, 0) < 30
      AND coalesce(q.p95_queue_sec, 0) < 1
      AND coalesce(c.list_cost, 0) > 0 THEN 'always_on_idle'
    ELSE 'healthy'
  END AS sizing_band,
  CASE
    WHEN coalesce(q.query_count, 0) = 0 AND coalesce(c.list_cost, 0) > 0
      THEN 'Stop or delete — billed with no warehouse queries in this window'
    WHEN coalesce(q.p95_queue_sec, 0) >= 5 OR coalesce(q.avg_queue_proportion, 0) >= 0.10
      THEN 'Raise max clusters or warehouse size — queries wait at capacity'
    WHEN coalesce(w.min_clusters, 0) = 0 AND coalesce(q.avg_wait_compute_sec, 0) >= 10
      THEN 'Set min clusters to 1 if cold start is blocking dashboards or jobs'
    WHEN coalesce(w.min_clusters, 0) >= 1
      AND coalesce(q.query_count, 0) < 30
      AND coalesce(q.p95_queue_sec, 0) < 1
      THEN 'Drop min clusters to 0 or shorten auto-stop — always-on with little use'
    ELSE 'Sizing matches demand — keep as a returning warehouse'
  END AS recommended_action
FROM keys k
LEFT JOIN warehouse_cost c
  ON k.workspace_id = c.workspace_id
  AND k.warehouse_id = c.warehouse_id
LEFT JOIN query_stats q
  ON k.workspace_id = q.workspace_id
  AND k.warehouse_id = q.warehouse_id
LEFT JOIN latest_warehouses w
  ON k.workspace_id = w.workspace_id
  AND k.warehouse_id = w.warehouse_id
LEFT JOIN warehouse_runtime r
  ON k.workspace_id = r.workspace_id
  AND k.warehouse_id = r.warehouse_id
ORDER BY coalesce(c.list_cost, 0) DESC, coalesce(q.query_count, 0) DESC
LIMIT :limit;

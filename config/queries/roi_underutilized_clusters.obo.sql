-- Executes on behalf of the signed-in user.
-- All-purpose clusters with low CPU/memory in the window, no auto-termination,
-- or billed spend with no node metrics. CPU fields follow compute.node_timeline
-- and the Cost & Usage Suite jobswithutil pattern.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param limit INT
WITH latest_clusters AS (
  SELECT
    workspace_id,
    cluster_id,
    cluster_name,
    owned_by,
    cluster_source,
    worker_node_type,
    worker_count,
    min_autoscale_workers,
    max_autoscale_workers,
    auto_termination_minutes,
    dbr_version,
    delete_time
  FROM system.compute.clusters
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY workspace_id, cluster_id
    ORDER BY change_time DESC
  ) = 1
),
all_purpose AS (
  SELECT *
  FROM latest_clusters
  WHERE cluster_source IN ('UI', 'API')
),
cluster_usage_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.cluster_id AS cluster_id,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.billing_origin_product = 'ALL_PURPOSE'
    AND u.usage_metadata.cluster_id IS NOT NULL
    AND u.usage_metadata.cluster_id <> ''
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.cluster_id
),
cluster_cost AS (
  SELECT
    u.workspace_id,
    u.cluster_id,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM cluster_usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.cluster_id
),
util AS (
  SELECT
    n.workspace_id,
    n.cluster_id,
    avg(coalesce(n.cpu_user_percent, 0) + coalesce(n.cpu_system_percent, 0)) AS avg_cpu_percent,
    avg(n.mem_used_percent) AS avg_mem_percent,
    avg(
      CASE
        WHEN coalesce(n.cpu_user_percent, 0) + coalesce(n.cpu_system_percent, 0) < 10 THEN 1.0
        ELSE 0.0
      END
    ) * 100 AS pct_minutes_cpu_below_10,
    count(*) AS sample_minutes,
    max(n.end_time) AS last_seen
  FROM system.compute.node_timeline n
  INNER JOIN all_purpose c
    ON n.workspace_id = c.workspace_id
    AND n.cluster_id = c.cluster_id
  WHERE DATE(n.start_time) >= CAST(:startDate AS DATE)
    AND DATE(n.start_time) <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR n.workspace_id = :workspaceId)
  GROUP BY n.workspace_id, n.cluster_id
  HAVING count(*) >= 30
)
SELECT
  c.workspace_id,
  c.cluster_id,
  c.cluster_name,
  c.owned_by,
  c.cluster_source,
  c.worker_node_type,
  c.worker_count,
  c.min_autoscale_workers,
  c.max_autoscale_workers,
  c.auto_termination_minutes,
  c.dbr_version,
  CASE WHEN c.delete_time IS NULL THEN false ELSE true END AS is_deleted,
  coalesce(u.avg_cpu_percent, 0) AS avg_cpu_percent,
  coalesce(u.pct_minutes_cpu_below_10, 0) AS pct_minutes_cpu_below_10,
  coalesce(u.avg_mem_percent, 0) AS avg_mem_percent,
  coalesce(u.sample_minutes, 0) AS sample_minutes,
  u.last_seen,
  coalesce(cc.list_cost, 0) AS list_cost,
  CASE
    WHEN u.cluster_id IS NULL THEN 'no_metrics'
    WHEN coalesce(c.auto_termination_minutes, 0) = 0 THEN 'no_auto_termination'
    WHEN coalesce(u.avg_cpu_percent, 0) < 15 THEN 'low_cpu'
    WHEN coalesce(u.avg_mem_percent, 0) < 25 THEN 'low_memory'
    ELSE 'underused'
  END AS util_band,
  CASE
    WHEN u.cluster_id IS NULL THEN 'Spend with no node metrics — confirm the cluster is still needed'
    WHEN coalesce(c.auto_termination_minutes, 0) = 0 THEN 'Set auto-termination so idle all-purpose clusters stop'
    WHEN coalesce(u.avg_cpu_percent, 0) < 15 THEN 'Downsize node type or worker count — CPU is mostly idle'
    WHEN coalesce(u.avg_mem_percent, 0) < 25 THEN 'Downsize memory — average memory use is low'
    ELSE 'Review idle minutes and move scheduled work to jobs compute'
  END AS recommended_action
FROM cluster_cost cc
INNER JOIN all_purpose c
  ON cc.workspace_id = c.workspace_id
  AND cc.cluster_id = c.cluster_id
LEFT JOIN util u
  ON cc.workspace_id = u.workspace_id
  AND cc.cluster_id = u.cluster_id
WHERE coalesce(cc.list_cost, 0) > 0
  AND (
    u.cluster_id IS NULL
    OR coalesce(c.auto_termination_minutes, 0) = 0
    OR coalesce(u.avg_cpu_percent, 0) < 20
    OR coalesce(u.pct_minutes_cpu_below_10, 0) >= 40
    OR coalesce(u.avg_mem_percent, 0) < 25
  )
ORDER BY coalesce(cc.list_cost, 0) DESC
LIMIT :limit;

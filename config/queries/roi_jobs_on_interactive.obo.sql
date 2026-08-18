-- Executes on behalf of the signed-in user.
-- Jobs whose task runs used all-purpose (interactive) clusters.
-- Jobs-cost billing only attributes jobs compute and serverless; all-purpose
-- spend is billed as ALL_PURPOSE on the cluster. Pattern from the jobs system
-- tables docs and the Cost & Usage Suite jobs_ap_clusters query.
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
    auto_termination_minutes
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
task_runs AS (
  SELECT
    t.workspace_id,
    t.job_id,
    explode(t.compute_ids) AS cluster_id,
    t.run_id,
    t.period_end_time
  FROM system.lakeflow.job_task_run_timeline t
  WHERE DATE(t.period_start_time) >= CAST(:startDate AS DATE)
    AND DATE(t.period_start_time) <= CAST(:endDate AS DATE)
    AND array_size(t.compute_ids) > 0
    AND (:workspaceScope = 'all' OR t.workspace_id = :workspaceId)
),
job_clusters AS (
  SELECT
    t.workspace_id,
    CAST(t.job_id AS STRING) AS job_id,
    t.cluster_id,
    count(DISTINCT t.run_id) AS task_runs,
    max(t.period_end_time) AS last_run
  FROM task_runs t
  INNER JOIN all_purpose c
    ON t.workspace_id = c.workspace_id
    AND t.cluster_id = c.cluster_id
  GROUP BY t.workspace_id, t.job_id, t.cluster_id
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
produced AS (
  SELECT
    l.workspace_id,
    CAST(l.entity_id AS STRING) AS job_id,
    count(DISTINCT l.target_table_full_name) AS produced_tables
  FROM system.access.table_lineage l
  WHERE l.event_date >= CAST(:startDate AS DATE)
    AND l.event_date <= CAST(:endDate AS DATE)
    AND l.entity_type = 'JOB'
    AND l.target_table_full_name IS NOT NULL
    AND (:workspaceScope = 'all' OR l.workspace_id = :workspaceId)
  GROUP BY l.workspace_id, l.entity_id
),
latest_jobs AS (
  SELECT
    workspace_id,
    CAST(job_id AS STRING) AS job_id,
    name,
    creator_user_name
  FROM system.lakeflow.jobs
  WHERE delete_time IS NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
)
SELECT
  jc.workspace_id,
  jc.job_id,
  coalesce(j.name, jc.job_id) AS job_name,
  coalesce(j.creator_user_name, c.owned_by) AS owned_by,
  jc.cluster_id,
  coalesce(c.cluster_name, jc.cluster_id) AS cluster_name,
  c.cluster_source,
  c.auto_termination_minutes,
  jc.task_runs,
  jc.last_run,
  coalesce(cc.list_cost, 0) AS cluster_list_cost,
  coalesce(pr.produced_tables, 0) AS produced_tables,
  'Move this job to jobs compute or serverless. All-purpose cluster spend is shared and is not jobs-cost attributed.' AS recommended_action
FROM job_clusters jc
INNER JOIN all_purpose c
  ON jc.workspace_id = c.workspace_id
  AND jc.cluster_id = c.cluster_id
LEFT JOIN cluster_cost cc
  ON jc.workspace_id = cc.workspace_id
  AND jc.cluster_id = cc.cluster_id
LEFT JOIN latest_jobs j
  ON jc.workspace_id = j.workspace_id
  AND jc.job_id = j.job_id
LEFT JOIN produced pr
  ON jc.workspace_id = pr.workspace_id
  AND jc.job_id = pr.job_id
ORDER BY coalesce(cc.list_cost, 0) DESC, jc.task_runs DESC
LIMIT :limit;

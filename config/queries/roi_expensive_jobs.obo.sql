-- Executes on behalf of the signed-in user.
-- Job list-price spend plus Unity Catalog lineage to downstream products that
-- read tables the job produced. Adapted from the jobs-cost system-table examples
-- and the Cost & Usage Suite unused-dataset pattern.
-- @param startDate DATE
-- @param endDate DATE
-- @param workspaceScope STRING
-- @param catalogPattern STRING
-- @param limit INT
WITH job_usage_daily AS (
  SELECT
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.job_id AS job_id,
    first(u.identity_metadata.run_as, true) AS run_as,
    max(u.usage_end_time) AS last_seen,
    sum(u.usage_quantity) AS dbus
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.usage_metadata.job_id IS NOT NULL
    AND u.usage_metadata.job_id <> ''
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY
    u.account_id,
    u.workspace_id,
    u.sku_name,
    u.cloud,
    u.usage_unit,
    u.usage_date,
    u.usage_metadata.job_id
),
job_runs AS (
  SELECT
    u.workspace_id,
    u.usage_metadata.job_id AS job_id,
    count(DISTINCT u.usage_metadata.job_run_id) AS runs
  FROM system.billing.usage u
  WHERE u.usage_date >= CAST(:startDate AS DATE)
    AND u.usage_date <= CAST(:endDate AS DATE)
    AND u.usage_metadata.job_id IS NOT NULL
    AND u.usage_metadata.job_id <> ''
    AND (:workspaceScope = 'all' OR u.workspace_id = :workspaceId)
  GROUP BY u.workspace_id, u.usage_metadata.job_id
),
job_cost AS (
  SELECT
    u.workspace_id,
    u.job_id,
    first(u.run_as, true) AS run_as,
    max(u.last_seen) AS last_seen,
    coalesce(sum(u.dbus), 0) AS dbus,
    coalesce(sum(u.dbus * coalesce(p.pricing.effective_list.default, p.pricing.default, 0)), 0) AS list_cost
  FROM job_usage_daily u
  LEFT JOIN system.billing.list_prices p
    ON u.account_id = p.account_id
    AND u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND u.usage_unit = p.usage_unit
    AND u.usage_date >= CAST(p.price_start_time AS DATE)
    AND (p.price_end_time IS NULL OR u.usage_date < CAST(p.price_end_time AS DATE))
  GROUP BY u.workspace_id, u.job_id
),
top_jobs AS (
  SELECT
    c.workspace_id,
    c.job_id,
    c.run_as,
    c.last_seen,
    c.dbus,
    c.list_cost,
    coalesce(r.runs, 0) AS runs
  FROM job_cost c
  LEFT JOIN job_runs r
    ON c.workspace_id = r.workspace_id
    AND c.job_id = r.job_id
  ORDER BY c.list_cost DESC
  LIMIT :limit
),
produced AS (
  SELECT DISTINCT
    l.workspace_id,
    l.entity_id AS job_id,
    l.target_table_full_name AS table_full_name
  FROM system.access.table_lineage l
  INNER JOIN top_jobs t
    ON l.workspace_id = t.workspace_id
    AND l.entity_id = t.job_id
  WHERE l.event_date >= CAST(:startDate AS DATE)
    AND l.event_date <= CAST(:endDate AS DATE)
    AND l.entity_type = 'JOB'
    AND l.target_table_full_name IS NOT NULL
    AND (
      :catalogPattern = '%'
      OR lower(coalesce(l.target_table_catalog, '')) LIKE lower(:catalogPattern)
    )
),
consumers AS (
  SELECT
    p.workspace_id,
    p.job_id,
    count(DISTINCT p.table_full_name) AS produced_tables,
    count(DISTINCT CASE WHEN c.entity_type = 'NOTEBOOK' THEN c.entity_id END) AS notebook_consumers,
    count(DISTINCT CASE WHEN c.entity_type IN ('DASHBOARD_V3', 'DASHBOARD') THEN c.entity_id END) AS dashboard_consumers,
    count(DISTINCT CASE WHEN c.entity_type = 'DBSQL_QUERY' THEN c.entity_id END) AS sql_query_consumers,
    count(DISTINCT CASE WHEN c.entity_type = 'PIPELINE' THEN c.entity_id END) AS pipeline_consumers,
    count(DISTINCT CASE WHEN c.entity_type = 'JOB' AND c.entity_id <> p.job_id THEN c.entity_id END) AS downstream_job_consumers,
    count(DISTINCT CASE
      WHEN coalesce(c.entity_type, '') IN ('', 'GENIE_SPACE', 'GENIE', 'AI_AGENT', 'MODEL_SERVING')
      THEN coalesce(c.entity_id, c.statement_id)
    END) AS query_or_agent_consumers
  FROM produced p
  LEFT JOIN system.access.table_lineage c
    ON c.source_table_full_name = p.table_full_name
    AND c.event_date >= CAST(:startDate AS DATE)
    AND c.event_date <= CAST(:endDate AS DATE)
    AND (:workspaceScope = 'all' OR c.workspace_id = :workspaceId)
  GROUP BY p.workspace_id, p.job_id
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
  t.workspace_id,
  t.job_id,
  coalesce(j.name, t.job_id) AS job_name,
  coalesce(t.run_as, j.creator_user_name) AS run_as,
  t.runs,
  t.dbus,
  t.list_cost,
  t.last_seen,
  coalesce(c.produced_tables, 0) AS produced_tables,
  coalesce(c.notebook_consumers, 0) AS notebook_consumers,
  coalesce(c.dashboard_consumers, 0) AS dashboard_consumers,
  coalesce(c.sql_query_consumers, 0) AS sql_query_consumers,
  coalesce(c.pipeline_consumers, 0) AS pipeline_consumers,
  coalesce(c.downstream_job_consumers, 0) AS downstream_job_consumers,
  coalesce(c.query_or_agent_consumers, 0) AS query_or_agent_consumers,
  coalesce(c.notebook_consumers, 0)
    + coalesce(c.dashboard_consumers, 0)
    + coalesce(c.sql_query_consumers, 0)
    + coalesce(c.pipeline_consumers, 0)
    + coalesce(c.downstream_job_consumers, 0)
    + coalesce(c.query_or_agent_consumers, 0) AS downstream_consumers,
  CASE
    WHEN coalesce(c.produced_tables, 0) = 0 THEN 'no_produced_tables'
    WHEN (
      coalesce(c.notebook_consumers, 0)
      + coalesce(c.dashboard_consumers, 0)
      + coalesce(c.sql_query_consumers, 0)
      + coalesce(c.pipeline_consumers, 0)
      + coalesce(c.downstream_job_consumers, 0)
      + coalesce(c.query_or_agent_consumers, 0)
    ) = 0 THEN 'no_downstream_use'
    ELSE 'cost_with_use'
  END AS roi_band,
  'system.billing.usage + system.access.table_lineage' AS metric_source
FROM top_jobs t
LEFT JOIN consumers c
  ON t.workspace_id = c.workspace_id
  AND t.job_id = c.job_id
LEFT JOIN latest_jobs j
  ON t.workspace_id = j.workspace_id
  AND t.job_id = j.job_id
ORDER BY t.list_cost DESC;

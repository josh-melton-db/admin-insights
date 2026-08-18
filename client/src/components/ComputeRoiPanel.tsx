import { useMemo } from 'react';
import { sql } from '@databricks/appkit-ui/js';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import { useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { FilteredTable } from '@/components/FilteredTable';
import { KpiGrid } from '@/components/KpiGrid';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { formatCurrency, formatNumber, formatPercent, toNumber } from '@/lib/formatters';
import { ALL_FILTER, COMPACT_LIST_FETCH_LIMIT, uniqueFilterOptions } from '@/lib/list-controls';
import type { AdminFilters } from '@/lib/filters';
import { clusterUrl, jobUrl, warehouseUrl } from '@/lib/workspace-links';

function utilBandLabel(band: string | null | undefined): string {
  if (band === 'no_auto_termination') return 'No auto-termination';
  if (band === 'low_cpu') return 'Low CPU';
  if (band === 'low_memory') return 'Low memory';
  if (band === 'no_metrics') return 'Spend, no metrics';
  if (band === 'underused') return 'Underused';
  return band ?? 'unknown';
}

function sizingBandLabel(band: string | null | undefined): string {
  if (band === 'spend_no_queries') return 'Spend with no queries';
  if (band === 'undersized_queued') return 'Queued: undersized';
  if (band === 'scaling_from_zero') return 'Cold start from 0';
  if (band === 'always_on_idle') return 'Always-on, little use';
  if (band === 'healthy') return 'Healthy';
  return band ?? 'unknown';
}

function wasteBadgeVariant(band: string | null | undefined): 'destructive' | 'outline' | 'secondary' {
  if (band === 'spend_no_queries' || band === 'always_on_idle' || band === 'no_auto_termination' || band === 'no_metrics') {
    return 'destructive';
  }
  if (band === 'healthy') {
    return 'secondary';
  }
  return 'outline';
}

export function ComputeRoiPanel({ filters, host }: { filters: AdminFilters; host: string | null }) {
  const rangeParams = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
    }),
    [filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const limited = useMemo(() => ({ ...rangeParams, limit: sql.number(COMPACT_LIST_FETCH_LIMIT) }), [rangeParams]);
  const interactiveJobs = useAnalyticsQuery('roi_jobs_on_interactive', limited);
  const clusters = useAnalyticsQuery('roi_underutilized_clusters', limited);
  const warehouses = useAnalyticsQuery('roi_warehouse_sizing', limited);
  const period = `${filters.startDate} to ${filters.endDate}`;
  const jobRows = interactiveJobs.data ?? [];
  const clusterRows = clusters.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const uniqueJobCount = new Set(jobRows.map((row) => `${row.workspace_id}-${row.job_id}`)).size;
  const interactiveClusterSpend = useMemo(() => {
    const byCluster = new Map<string, number>();
    for (const row of jobRows) {
      byCluster.set(`${row.workspace_id}-${row.cluster_id}`, toNumber(row.cluster_list_cost));
    }
    return [...byCluster.values()].reduce((sum, value) => sum + value, 0);
  }, [jobRows]);
  const warehouseActionCount = warehouseRows.filter((row) => row.sizing_band !== 'healthy').length;
  const clusterBandOptions = useMemo(
    () => uniqueFilterOptions(clusterRows.map((row) => utilBandLabel(row.util_band)), 'All utilization bands'),
    [clusterRows],
  );
  const warehouseBandOptions = useMemo(
    () => uniqueFilterOptions(warehouseRows.map((row) => sizingBandLabel(row.sizing_band)), 'All sizing bands'),
    [warehouseRows],
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Jobs-cost billing does not include jobs on all-purpose clusters or SQL warehouses. This tab compares that
        compute spend to return: produced tables, warehouse queries from dashboards/Genie/jobs/notebooks, and idle
        capacity.
      </p>
      <KpiGrid
        items={[
          {
            title: 'Interactive jobs',
            value: interactiveJobs.loading ? '…' : formatNumber(uniqueJobCount),
            unit: 'distinct jobs using UI/API clusters',
            period,
            source: 'lakeflow.job_task_run_timeline + compute.clusters',
          },
          {
            title: 'Interactive cluster spend',
            value: interactiveJobs.loading ? '…' : formatCurrency(interactiveClusterSpend),
            unit: 'USD list on clusters those jobs used (shared)',
            period,
            source: 'billing.usage ALL_PURPOSE',
          },
          {
            title: 'Idle all-purpose clusters',
            value: clusters.loading ? '…' : formatNumber(clusterRows.length),
            unit: 'all-purpose clusters with idle CPU, no auto-stop, or no metrics',
            period,
            source: 'compute.node_timeline',
          },
          {
            title: 'Warehouses to resize',
            value: warehouses.loading ? '…' : formatNumber(warehouseActionCount),
            unit: 'not healthy — queued, always-on idle, or spend with no queries',
            period,
            source: 'query.history + billing.usage',
          },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>Jobs on interactive compute</CardTitle>
          <CardDescription>
            Task runs on all-purpose (UI/API) clusters. Cluster spend is shared across every job that used the cluster
            in this window. Move scheduled work to jobs compute or serverless.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={interactiveJobs.loading}
            error={interactiveJobs.error}
            rows={jobRows}
            emptyTitle="No jobs on all-purpose clusters"
            emptyDescription="No job task runs used a UI or API cluster in this window, or system.compute / lakeflow.job_task_run_timeline is not visible."
            searchLabel="Filter interactive jobs"
            searchPlaceholder="Job, cluster, or owner"
            getSearchText={(row) => `${row.job_name} ${row.cluster_name} ${row.owned_by} ${row.job_id}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Cluster</TableHead>
                    <TableHead>Task runs</TableHead>
                    <TableHead>Produced tables</TableHead>
                    <TableHead>Cluster spend</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.job_id}-${row.cluster_id}`}>
                      <TableCell>
                        <WorkspaceLink href={jobUrl(host, row.job_id)}>{row.job_name}</WorkspaceLink>
                        <div className="text-xs text-muted-foreground">{row.owned_by}</div>
                      </TableCell>
                      <TableCell>
                        <WorkspaceLink href={clusterUrl(host, row.cluster_id)}>{row.cluster_name}</WorkspaceLink>
                        <div className="text-xs text-muted-foreground">{row.cluster_source}</div>
                      </TableCell>
                      <TableCell>{formatNumber(row.task_runs)}</TableCell>
                      <TableCell>{formatNumber(row.produced_tables)}</TableCell>
                      <TableCell>{formatCurrency(row.cluster_list_cost)}</TableCell>
                      <TableCell className="max-w-xs text-sm text-muted-foreground">{row.recommended_action}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Underutilized clusters</CardTitle>
          <CardDescription>
            All-purpose clusters with billed spend and low average CPU, many minutes under 10% CPU, no auto-termination,
            or no node metrics. Open the cluster to downsize or set auto-stop.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={clusters.loading}
            error={clusters.error}
            rows={clusterRows}
            emptyTitle="No underutilized all-purpose clusters"
            emptyDescription="No UI/API clusters with spend and idle CPU, missing auto-termination, or missing metrics matched this filter."
            searchLabel="Filter clusters"
            searchPlaceholder="Cluster, owner, or node type"
            getSearchText={(row) => `${row.cluster_name} ${row.owned_by} ${row.worker_node_type} ${row.util_band}`}
            filters={[
              {
                id: 'band',
                label: 'Utilization',
                options: clusterBandOptions,
                match: (row, value) => value === ALL_FILTER || utilBandLabel(row.util_band) === value,
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cluster</TableHead>
                    <TableHead>CPU / memory</TableHead>
                    <TableHead>Auto-stop</TableHead>
                    <TableHead>Spend</TableHead>
                    <TableHead>Finding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.cluster_id}`}>
                      <TableCell>
                        <WorkspaceLink href={clusterUrl(host, row.cluster_id)}>{row.cluster_name}</WorkspaceLink>
                        <div className="text-xs text-muted-foreground">
                          {row.owned_by} · {row.worker_node_type}
                          {row.worker_count != null ? ` · ${formatNumber(row.worker_count)} workers` : ''}
                        </div>
                      </TableCell>
                      <TableCell>
                        {formatPercent(row.avg_cpu_percent)} CPU · {formatPercent(row.avg_mem_percent)} mem
                        <div className="text-xs text-muted-foreground">
                          {formatPercent(row.pct_minutes_cpu_below_10)} of minutes under 10% CPU
                        </div>
                      </TableCell>
                      <TableCell>
                        {toNumber(row.auto_termination_minutes) > 0
                          ? `${formatNumber(row.auto_termination_minutes)} min`
                          : 'Off'}
                      </TableCell>
                      <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                      <TableCell>
                        <Badge variant={wasteBadgeVariant(row.util_band)}>{utilBandLabel(row.util_band)}</Badge>
                        <div className="mt-1 max-w-xs text-xs text-muted-foreground">{row.recommended_action}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>SQL warehouse sizing</CardTitle>
          <CardDescription>
            Spend next to query return (dashboards, Genie, jobs, notebooks) and wait time. Queue at capacity means
            undersized; spend with no queries or always-on min clusters with little use is wasted investment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={warehouses.loading}
            error={warehouses.error}
            rows={warehouseRows}
            emptyTitle="No warehouse activity"
            emptyDescription="No SQL warehouse spend or queries matched this window, or system.compute.warehouses is not visible."
            searchLabel="Filter warehouses"
            searchPlaceholder="Warehouse, size, or finding"
            getSearchText={(row) =>
              `${row.warehouse_name} ${row.warehouse_size} ${row.warehouse_type} ${row.sizing_band} ${row.created_by}`
            }
            filters={[
              {
                id: 'band',
                label: 'Sizing',
                options: warehouseBandOptions,
                match: (row, value) => value === ALL_FILTER || sizingBandLabel(row.sizing_band) === value,
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Warehouse</TableHead>
                    <TableHead>Queries / return</TableHead>
                    <TableHead>Wait</TableHead>
                    <TableHead>Spend</TableHead>
                    <TableHead>Finding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.warehouse_id}`}>
                      <TableCell>
                        <WorkspaceLink href={warehouseUrl(host, row.warehouse_id)}>{row.warehouse_name}</WorkspaceLink>
                        <div className="text-xs text-muted-foreground">
                          {row.warehouse_type ?? 'unknown'} · {row.warehouse_size ?? 'unknown'} · min{' '}
                          {formatNumber(row.min_clusters)} / max {formatNumber(row.max_clusters)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {formatNumber(row.query_count)} queries · {formatNumber(row.distinct_users)} users
                        <div className="text-xs text-muted-foreground">
                          {formatNumber(row.dashboard_queries)} dash · {formatNumber(row.genie_queries)} genie ·{' '}
                          {formatNumber(row.job_queries)} jobs · {formatNumber(row.notebook_queries)} nb
                        </div>
                      </TableCell>
                      <TableCell>
                        p95 queue {toNumber(row.p95_queue_sec).toFixed(1)}s
                        <div className="text-xs text-muted-foreground">
                          cold start {toNumber(row.avg_wait_compute_sec).toFixed(1)}s · queue{' '}
                          {formatPercent(toNumber(row.avg_queue_proportion) * 100)}
                        </div>
                      </TableCell>
                      <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                      <TableCell>
                        <Badge variant={wasteBadgeVariant(row.sizing_band)}>{sizingBandLabel(row.sizing_band)}</Badge>
                        <div className="mt-1 max-w-xs text-xs text-muted-foreground">{row.recommended_action}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        </CardContent>
      </Card>
    </div>
  );
}

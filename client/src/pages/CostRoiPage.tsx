import { useMemo } from 'react';
import { useOutletContext } from 'react-router';
import { sql } from '@databricks/appkit-ui/js';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  BarChart,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@databricks/appkit-ui/react';
import { useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { ComputeRoiPanel } from '@/components/ComputeRoiPanel';
import { AiUsagePanel, TaggedSpendPanel } from '@/components/CostGovernancePanels';
import { FilterBar } from '@/components/FilterBar';
import { FilteredTable } from '@/components/FilteredTable';
import { KpiGrid } from '@/components/KpiGrid';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { formatCurrency, formatNumber, toNumber } from '@/lib/formatters';
import { ALL_FILTER, COMPACT_LIST_FETCH_LIMIT, scaleToZeroLabel, scaleToZeroListFilter, uniqueFilterOptions } from '@/lib/list-controls';
import type { AdminOutletContext } from '@/lib/outlet';
import {
  appDetailsUrl,
  genieSpaceUrl,
  jobUrl,
  pipelineUrl,
  servingEndpointUrl,
  tableExplorerUrl,
  tableUrlFromFullName,
  vectorSearchUrl,
  workspaceResourceUrl,
} from '@/lib/workspace-links';

function roiBandLabel(band: string | null | undefined): string {
  if (band === 'no_downstream_use') return 'Low ROI: no downstream use';
  if (band === 'no_produced_tables') return 'Low ROI: no produced tables';
  if (band === 'cost_with_use') return 'High ROI: spend with use';
  return band ?? 'unknown';
}

function genieAllowanceLabel(band: string | null | undefined): string {
  if (band === 'within_code_allowance') return 'Within 150 DBU Code allowance';
  if (band === 'code_allowance_used') return 'Genie Code billed above 150 DBUs';
  if (band === 'no_user_allowance') return 'Service principal — billed (no user allowance)';
  return band ?? 'unknown';
}

function appUsageLabel(band: string | null | undefined): string {
  if (band === 'has_user_obo') return 'User authorization';
  if (band === 'app_sp_only_suspected') return 'App SP only (suspected)';
  if (band === 'no_user_obo') return 'No user OBO';
  return band ?? 'unknown';
}

function returnUnitLabel(unit: string | null | undefined, count: number | string | null | undefined): string {
  const n = toNumber(count);
  if (unit === 'questions') return `${formatNumber(n)} questions`;
  if (unit === 'index_queries') return `${formatNumber(n)} index queries`;
  if (unit === 'queries') return `${formatNumber(n)} queries`;
  return '—';
}

function producerUrl(host: string | null, producerType: string | null | undefined, producerId: string | null | undefined) {
  if (producerType === 'JOB') return jobUrl(host, producerId);
  if (producerType === 'PIPELINE') return pipelineUrl(host, producerId);
  return null;
}

export function CostRoiPage() {
  const { filters, setFilters, identity } = useOutletContext<AdminOutletContext>();
  const host = identity?.runtime.workspaceHost ?? null;
  const rangeParams = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
    }),
    [filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const limited = useMemo(() => ({ ...rangeParams, limit: sql.number(COMPACT_LIST_FETCH_LIMIT) }), [rangeParams]);
  const lineageLimited = useMemo(
    () => ({
      ...rangeParams,
      catalogPattern: sql.string(filters.catalogPattern || '%'),
      limit: sql.number(COMPACT_LIST_FETCH_LIMIT),
    }),
    [filters.catalogPattern, rangeParams],
  );
  const estateParams = useMemo(
    () => ({
      ...rangeParams,
      catalogPattern: sql.string(filters.catalogPattern || '%'),
    }),
    [filters.catalogPattern, rangeParams],
  );
  const roi = useAnalyticsQuery('roi_overview_kpis', estateParams);
  const sqlActivity = useAnalyticsQuery('roi_sql_activity_kpis', rangeParams);
  const jobs = useAnalyticsQuery('roi_expensive_jobs', lineageLimited);
  const unusedTables = useAnalyticsQuery('roi_unused_produced_tables', lineageLimited);
  const consumedTables = useAnalyticsQuery('roi_top_consumed_tables', lineageLimited);
  const idleServing = useAnalyticsQuery('roi_idle_serving', limited);
  const servingReturn = useAnalyticsQuery('roi_serving_return', limited);
  const knowledgeAssistants = useAnalyticsQuery('roi_knowledge_assistants', limited);
  const vectorIndexes = useAnalyticsQuery('roi_vector_index_return', limited);
  const idleVector = useAnalyticsQuery('roi_idle_vector_search', limited);
  const spendByProduct = useAnalyticsQuery('cost_by_product', rangeParams);
  const topResources = useAnalyticsQuery('roi_expensive_resources', limited);
  const appUsage = useAnalyticsQuery('hygiene_app_usage', limited);
  const gateway = useAnalyticsQuery('ai_gateway_usage', rangeParams);
  const resourceKindOptions = useMemo(
    () => uniqueFilterOptions((topResources.data ?? []).map((row) => row.resource_kind), 'All resources'),
    [topResources.data],
  );
  const period = `${filters.startDate} to ${filters.endDate}`;
  const activeUsers = toNumber(roi.data?.[0]?.active_users);
  const tableCount = toNumber(roi.data?.[0]?.table_count);
  const jobCount = toNumber(roi.data?.[0]?.job_count);
  const endpointCount = toNumber(roi.data?.[0]?.serving_endpoint_count);
  const modelCount = toNumber(roi.data?.[0]?.managed_model_count);
  const rowsProcessed = toNumber(sqlActivity.data?.[0]?.rows_read) + toNumber(sqlActivity.data?.[0]?.rows_returned);
  const jobRows = jobs.data ?? [];
  const highRoiJobs = jobRows.filter((row) => row.roi_band === 'cost_with_use');
  const lowRoiJobs = jobRows.filter((row) => row.roi_band !== 'cost_with_use');
  const rateLimitErrors = (gateway.data ?? []).reduce((sum, row) => sum + Number(row.rate_or_budget_errors ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Return on spend</h2>
        <p className="text-sm text-muted-foreground">
          Return ties attributed spend to people, tables, jobs, serving, models, and Genie — not SQL queries alone.
          Wasted spend is billed compute with no usage signal. The Compute tab adds jobs on all-purpose clusters,
          underutilized clusters, and SQL warehouse sizing. Databricks-funded Genie usage is called out separately from
          billed investment.
        </p>
      </div>
      <FilterBar filters={filters} onChange={setFilters} />
      <Tabs defaultValue="return">
        <TabsList>
          <TabsTrigger value="return">Return</TabsTrigger>
          <TabsTrigger value="compute">Compute</TabsTrigger>
        </TabsList>
        <TabsContent value="return" className="space-y-6">
      <KpiGrid
        items={[
          {
            title: 'Active users',
            value: roi.loading ? '…' : formatNumber(activeUsers),
            unit: 'email principals in audit',
            period,
            source: 'access.audit via actor_activity_daily',
          },
          {
            title: 'Tables managed',
            value: roi.loading ? '…' : formatNumber(tableCount),
            unit: 'UC tables, views, MVs, and metric views',
            period,
            source: 'information_schema.tables',
          },
          {
            title: 'Jobs, endpoints, models',
            value: roi.loading ? '…' : `${formatNumber(jobCount)} · ${formatNumber(endpointCount)} · ${formatNumber(modelCount)}`,
            unit: roi.loading
              ? 'jobs · serving endpoints · custom/external models'
              : `${formatNumber(roi.data?.[0]?.serving_always_on_count)} always-on serving · ${formatNumber(roi.data?.[0]?.serving_scale_to_zero_count)} scale to zero`,
            period,
            source: 'lakeflow.jobs + serving.served_entities',
          },
          {
            title: 'SQL rows processed',
            value: sqlActivity.loading ? '…' : formatNumber(rowsProcessed),
            unit: 'read + produced in SQL; estate row counts are not collected',
            period,
            source: 'system.query.history',
          },
        ]}
      />
      <GenieRoiSection
        period={period}
        host={host}
        rangeParams={rangeParams}
        limited={limited}
        workspaceScope={filters.workspaceScope}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Attributed spend by product</CardTitle>
            <CardDescription>
              Daily list-price spend by product family. Each family has a return path or action in the table below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              queryKey="roi_spend_by_product_trend"
              parameters={rangeParams}
              format="json"
              stacked
              colorPalette="categorical"
              xKey="usage_date"
              yKey={[
                'jobs_spend',
                'sql_spend',
                'serving_spend',
                'apps_spend',
                'vector_search_spend',
                'genie_spend',
                'other_spend',
              ]}
              height={280}
              ariaLabel="Attributed spend by product over time"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Wasted spend over time</CardTitle>
            <CardDescription>
              Always-on serving with no queries is billed replica waste. Scale-to-zero idle spend is usually residual.
              Vector Search with no indexes (excluding Agent Bricks ka- / mas- endpoints) and apps with no
              user-authorization (OBO) actions are also included.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              queryKey="roi_wasted_spend_trend"
              parameters={rangeParams}
              format="json"
              stacked
              colorPalette="categorical"
              xKey="usage_date"
              yKey={['idle_always_on_serving_spend', 'idle_scale_to_zero_serving_spend', 'vector_search_no_index_spend', 'app_no_user_obo_spend']}
              height={280}
              ariaLabel="Wasted spend over time"
            />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Spend by product with return or action</CardTitle>
          <CardDescription>Never spend in isolation: each product maps to downstream use or a next step.</CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={spendByProduct.loading}
            error={spendByProduct.error}
            rows={spendByProduct.data ?? []}
            emptyTitle="No product spend"
            emptyDescription="No billing rows matched this filter."
            searchLabel="Filter products"
            searchPlaceholder="Product, return, or action"
            getSearchText={(row) => `${row.product} ${row.return_signal} ${row.recommended_action}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Attributed spend</TableHead>
                    <TableHead>Return</TableHead>
                    <TableHead>Return signal</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={row.product}>
                      <TableCell>{row.product}</TableCell>
                      <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                      <TableCell>
                        {row.return_unit && row.return_unit !== 'none'
                          ? returnUnitLabel(row.return_unit, row.return_count)
                          : '—'}
                      </TableCell>
                      <TableCell className="max-w-xs text-sm text-muted-foreground">{row.return_signal}</TableCell>
                      <TableCell className="max-w-xs text-sm">{row.recommended_action}</TableCell>
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
          <CardTitle>Highest-spend resources</CardTitle>
          <CardDescription>Open the resource to inspect return. Spend is shown next to queries or questions when those signals exist.</CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={topResources.loading}
            error={topResources.error}
            rows={topResources.data ?? []}
            emptyTitle="No resource-attributed spend"
            emptyDescription="No billing rows with a job, warehouse, endpoint, or app matched this filter."
            searchLabel="Filter resources"
            searchPlaceholder="Resource name or product"
            getSearchText={(row) => `${row.resource_name} ${row.resource_kind} ${row.product} ${row.recommended_action}`}
            filters={[
              {
                id: 'kind',
                label: 'Resource',
                options: resourceKindOptions,
                match: (row, value) => value === ALL_FILTER || row.resource_kind === value,
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Resource</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Attributed spend</TableHead>
                    <TableHead>Return</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.resource_kind}-${row.resource_id}`}>
                      <TableCell>
                        <WorkspaceLink href={workspaceResourceUrl(host, row.resource_kind, row.resource_id, row.workspace_id)}>
                          {row.resource_name}
                        </WorkspaceLink>
                        <div className="text-xs text-muted-foreground">{row.resource_kind}</div>
                      </TableCell>
                      <TableCell>{row.product}</TableCell>
                      <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                      <TableCell>
                        {row.return_unit && row.return_unit !== 'none'
                          ? returnUnitLabel(row.return_unit, row.return_count)
                          : '—'}
                      </TableCell>
                      <TableCell className="max-w-sm text-sm text-muted-foreground">{row.recommended_action}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        </CardContent>
      </Card>
      <TaggedSpendPanel filters={filters} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>High-ROI jobs</CardTitle>
            <CardDescription>Top-spend jobs whose produced tables are read by notebooks, dashboards, queries, pipelines, or other jobs.</CardDescription>
          </CardHeader>
          <CardContent>
            <JobRoiTable
              rows={highRoiJobs}
              host={host}
              loading={jobs.loading}
              error={jobs.error}
              emptyTitle="No high-ROI jobs in top spend"
              emptyDescription="None of the highest-spend jobs in this window have downstream consumers."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Low-ROI jobs</CardTitle>
            <CardDescription>Top-spend jobs with no produced tables or no downstream readers. Open the job to pause, tag, or inspect lineage.</CardDescription>
          </CardHeader>
          <CardContent>
            <JobRoiTable
              rows={lowRoiJobs}
              host={host}
              loading={jobs.loading}
              error={jobs.error}
              emptyTitle="No low-ROI jobs in top spend"
              emptyDescription="Every highest-spend job in this window has downstream use."
            />
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Most consumed tables</CardTitle>
            <CardDescription>Lineage sources with the most distinct downstream entities — the return side of ROI.</CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={consumedTables.loading}
              error={consumedTables.error}
              rows={consumedTables.data ?? []}
              emptyTitle="No consumed tables"
              emptyDescription="No lineage reads matched this catalog and date filter."
              searchLabel="Filter consumed tables"
              searchPlaceholder="Table name"
              getSearchText={(row) => row.table_full_name}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Table</TableHead>
                      <TableHead>Consumers</TableHead>
                      <TableHead>Reads</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.table_full_name}`}>
                        <TableCell>
                          <WorkspaceLink
                            href={tableExplorerUrl(host, row.catalog_name, row.schema_name, row.table_name)}
                          >
                            {row.table_full_name}
                          </WorkspaceLink>
                          <div className="text-xs text-muted-foreground">
                            {formatNumber(row.notebook_consumers)} nb · {formatNumber(row.dashboard_consumers)} dash ·{' '}
                            {formatNumber(row.sql_query_consumers)} sql · {formatNumber(row.job_consumers)} jobs
                          </div>
                        </TableCell>
                        <TableCell>{formatNumber(row.consumer_entities)}</TableCell>
                        <TableCell>{formatNumber(row.read_events)}</TableCell>
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
            <CardTitle>Produced tables with no reads</CardTitle>
            <CardDescription>
              Job and pipeline outputs that never appear as a lineage source. Unused data product, not missing storage
              stats. Open the table or producer to retire or tag it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={unusedTables.loading}
              error={unusedTables.error}
              rows={unusedTables.data ?? []}
              emptyTitle="No unread produced tables"
              emptyDescription="Every table written in this window was also read, or no write lineage was recorded."
              searchLabel="Filter unread tables"
              searchPlaceholder="Table or producer"
              getSearchText={(row) => `${row.table_full_name} ${row.producer_type} ${row.producer_id}`}
              filters={[
                {
                  id: 'producer',
                  label: 'Producer',
                  options: [
                    { value: ALL_FILTER, label: 'All producers' },
                    { value: 'JOB', label: 'Jobs' },
                    { value: 'PIPELINE', label: 'Pipelines' },
                  ],
                  match: (row, value) => value === ALL_FILTER || row.producer_type === value,
                },
              ]}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Table</TableHead>
                      <TableHead>Producer</TableHead>
                      <TableHead>Last write</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.table_full_name}`}>
                        <TableCell>
                          <WorkspaceLink href={tableUrlFromFullName(host, row.table_full_name)}>
                            {row.table_full_name}
                          </WorkspaceLink>
                        </TableCell>
                        <TableCell>
                          <WorkspaceLink href={producerUrl(host, row.producer_type, row.producer_id)}>
                            {row.producer_type} · {row.producer_id}
                          </WorkspaceLink>
                        </TableCell>
                        <TableCell>{String(row.last_write_time)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </FilteredTable>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Serving with no queries</CardTitle>
            <CardDescription>
              MODEL_SERVING attributed spend with zero endpoint_usage requests, excluding databricks-% foundation
              models. Filter by scale to zero. Open the endpoint to stop or delete it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={idleServing.loading}
              error={idleServing.error}
              rows={idleServing.data ?? []}
              emptyTitle="No idle serving endpoints"
              emptyDescription="Every billed serving endpoint received at least one request, or serving usage is not visible."
              searchLabel="Filter idle serving"
              searchPlaceholder="Endpoint name"
              getSearchText={(row) => `${row.endpoint_name} ${scaleToZeroLabel(row.scale_to_zero_band)}`}
              filters={[scaleToZeroListFilter('Idle serving scale to zero')]}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Scale</TableHead>
                      <TableHead>Attributed spend</TableHead>
                      <TableHead>Requests</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.endpoint_name}`}>
                        <TableCell>
                          <WorkspaceLink href={servingEndpointUrl(host, row.endpoint_name)}>
                            {row.endpoint_name}
                          </WorkspaceLink>
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.scale_to_zero_band === 'does_not_scale_to_zero' ? 'secondary' : 'outline'}>
                            {scaleToZeroLabel(row.scale_to_zero_band)}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                        <TableCell>{formatNumber(row.request_count)}</TableCell>
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
            <CardTitle>Vector Search with no indexes</CardTitle>
            <CardDescription>
              VECTOR_SEARCH spend whose usage rows have no index_id. Agent Bricks ka- and mas- endpoints are excluded.
              Open the endpoint to delete it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={idleVector.loading}
              error={idleVector.error}
              rows={idleVector.data ?? []}
              emptyTitle="No index-less Vector Search spend"
              emptyDescription="No VECTOR_SEARCH billing rows lacked an index_id after excluding Agent Bricks endpoints."
              searchLabel="Filter Vector Search"
              searchPlaceholder="Endpoint name"
              getSearchText={(row) => row.endpoint_name}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Indexes</TableHead>
                      <TableHead>Attributed spend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.endpoint_name}`}>
                        <TableCell>
                          <WorkspaceLink href={vectorSearchUrl(host, row.endpoint_name)}>
                            {row.endpoint_name}
                          </WorkspaceLink>
                        </TableCell>
                        <TableCell>{formatNumber(row.index_count)}</TableCell>
                        <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </FilteredTable>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Serving with queries</CardTitle>
            <CardDescription>
              MODEL_SERVING attributed spend next to endpoint_usage queries. Knowledge Assistant endpoints are listed
              separately. Cost per query is list spend divided by requests.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={servingReturn.loading}
              error={servingReturn.error}
              rows={servingReturn.data ?? []}
              emptyTitle="No serving queries"
              emptyDescription="No billed serving endpoint received endpoint_usage requests in this window."
              searchLabel="Filter serving with queries"
              searchPlaceholder="Endpoint name"
              getSearchText={(row) => row.endpoint_name}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Attributed spend</TableHead>
                      <TableHead>Queries</TableHead>
                      <TableHead>Spend / query</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.endpoint_name}`}>
                        <TableCell>
                          <WorkspaceLink href={servingEndpointUrl(host, row.endpoint_name)}>
                            {row.endpoint_name}
                          </WorkspaceLink>
                        </TableCell>
                        <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                        <TableCell>{formatNumber(row.query_count)}</TableCell>
                        <TableCell>{row.cost_per_query == null ? '—' : formatCurrency(row.cost_per_query, 2)}</TableCell>
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
            <CardTitle>Vector Search index queries</CardTitle>
            <CardDescription>
              queryVectorIndex events per index. Spend joins when the index maps to a billed endpoint (create in the
              last 90 days, or a Knowledge Assistant vs-endpoint).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={vectorIndexes.loading}
              error={vectorIndexes.error}
              rows={vectorIndexes.data ?? []}
              emptyTitle="No index queries"
              emptyDescription="No Vector Search queryVectorIndex events in the 90-day return MV for this window."
              searchLabel="Filter vector indexes"
              searchPlaceholder="Index or endpoint"
              getSearchText={(row) => `${row.index_name} ${row.endpoint_name ?? ''} ${row.index_kind}`}
              filters={[
                {
                  id: 'kind',
                  label: 'Index kind',
                  options: uniqueFilterOptions(
                    (vectorIndexes.data ?? []).map((row) => row.index_kind),
                    'All index kinds',
                  ),
                  match: (row, value) => value === ALL_FILTER || row.index_kind === value,
                },
              ]}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Index</TableHead>
                      <TableHead>Queries</TableHead>
                      <TableHead>Attributed spend</TableHead>
                      <TableHead>Spend / query</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.index_name}`}>
                        <TableCell>
                          <WorkspaceLink href={vectorSearchUrl(host, row.endpoint_name)}>{row.index_name}</WorkspaceLink>
                          <div className="text-xs text-muted-foreground">
                            {row.endpoint_name || 'Endpoint unknown'}
                            {row.index_kind ? ` · ${row.index_kind}` : ''}
                          </div>
                        </TableCell>
                        <TableCell>{formatNumber(row.query_count)}</TableCell>
                        <TableCell>{row.list_cost == null ? '—' : formatCurrency(row.list_cost)}</TableCell>
                        <TableCell>{row.cost_per_query == null ? '—' : formatCurrency(row.cost_per_query, 2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </FilteredTable>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Knowledge assistants</CardTitle>
          <CardDescription>
            AGENT_BRICKS attributed spend next to questions answered. Questions are Vector Search queries against the
            assistant&apos;s ka_ index, not examples indexes. Open the serving endpoint to inspect or stop it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={knowledgeAssistants.loading}
            error={knowledgeAssistants.error}
            rows={knowledgeAssistants.data ?? []}
            emptyTitle="No Knowledge Assistant spend"
            emptyDescription="No AGENT_BRICKS billing rows with an agent_bricks_id in this range."
            searchLabel="Filter knowledge assistants"
            searchPlaceholder="Agent ID or endpoint"
            getSearchText={(row) => `${row.agent_id} ${row.endpoint_name}`}
            filters={[
              {
                id: 'questions',
                label: 'Knowledge assistant questions',
                options: [
                  { value: ALL_FILTER, label: 'All assistants' },
                  { value: 'has_questions', label: 'Has questions' },
                  { value: 'no_questions', label: 'No questions' },
                ],
                match: (row, value) => value === ALL_FILTER || row.usage_band === value,
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Assistant</TableHead>
                    <TableHead>Attributed spend</TableHead>
                    <TableHead>Questions</TableHead>
                    <TableHead>Spend / question</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.agent_id}`}>
                      <TableCell>
                        <WorkspaceLink href={servingEndpointUrl(host, row.endpoint_name)}>
                          {row.endpoint_name}
                        </WorkspaceLink>
                        <div className="text-xs text-muted-foreground">{row.agent_id}</div>
                      </TableCell>
                      <TableCell>{formatCurrency(row.list_cost)}</TableCell>
                      <TableCell>{formatNumber(row.question_count)}</TableCell>
                      <TableCell>
                        {row.cost_per_question == null ? '—' : formatCurrency(row.cost_per_question, 2)}
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
          <CardTitle>App usage: user authorization</CardTitle>
          <CardDescription>
            Usage is user-authorization (OBO) actions from audit, not compute billing on/off. Open Insights on the app
            details page for viewers and uptime. Apps without user API scopes may run only as the app service principal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={appUsage.loading}
            error={appUsage.error}
            rows={appUsage.data ?? []}
            emptyTitle="No billed apps"
            emptyDescription="No billing rows with app_id in this range."
            searchLabel="Filter apps"
            searchPlaceholder="App name"
            getSearchText={(row) => `${row.app_name} ${row.usage_band} ${row.scope_band}`}
            filters={[
              {
                id: 'return',
                label: 'Return',
                options: [
                  { value: ALL_FILTER, label: 'All return bands' },
                  { value: 'has_user_obo', label: 'User authorization' },
                  { value: 'app_sp_only_suspected', label: 'App SP only' },
                  { value: 'no_user_obo', label: 'No user OBO' },
                ],
                match: (row, value) => value === ALL_FILTER || row.usage_band === value,
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>App</TableHead>
                    <TableHead>Last billed</TableHead>
                    <TableHead>User OBO</TableHead>
                    <TableHead>Scopes</TableHead>
                    <TableHead>Return</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.app_id}`}>
                      <TableCell>
                        <WorkspaceLink href={appDetailsUrl(host, row.app_name, row.workspace_id)}>{row.app_name}</WorkspaceLink>
                      </TableCell>
                      <TableCell>{String(row.last_usage_date)}</TableCell>
                      <TableCell>
                        {formatNumber(row.user_obo_events)} events · {formatNumber(row.user_obo_users)} users
                        <div className="text-xs text-muted-foreground">
                          {row.last_obo_date ? String(row.last_obo_date) : 'No OBO in range'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.scope_band === 'has_user_api_scopes' ? 'secondary' : 'outline'}>
                          {row.scope_band === 'no_user_api_scopes'
                            ? 'No user API scopes'
                            : row.scope_band === 'has_user_api_scopes'
                              ? 'Has user API scopes'
                              : 'Scopes unknown'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.usage_band === 'has_user_obo' ? 'secondary' : 'destructive'}>
                          {appUsageLabel(row.usage_band)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        </CardContent>
      </Card>
      <AiUsagePanel filters={filters} host={host} />
      <Alert>
        <AlertTitle>AI Gateway rate limits</AlertTitle>
        <AlertDescription>
          AI Gateway rate limits apply to model and MCP services, not Genie. {formatNumber(rateLimitErrors)} gateway
          429/402 errors were observed in this range.
        </AlertDescription>
      </Alert>
      {jobs.error || unusedTables.error || idleServing.error || servingReturn.error || knowledgeAssistants.error || vectorIndexes.error || roi.error || sqlActivity.error ? (
        <p className="text-sm text-destructive">
          Partial permission: some ROI queries failed. Remaining panels still render.
        </p>
      ) : null}
        </TabsContent>
        <TabsContent value="compute" className="space-y-6">
          <ComputeRoiPanel filters={filters} host={host} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function GenieRoiSection({
  period,
  host,
  rangeParams,
  limited,
  workspaceScope,
}: {
  period: string;
  host: string | null;
  rangeParams: {
    startDate: ReturnType<typeof sql.date>;
    endDate: ReturnType<typeof sql.date>;
    workspaceScope: ReturnType<typeof sql.string>;
  };
  limited: {
    startDate: ReturnType<typeof sql.date>;
    endDate: ReturnType<typeof sql.date>;
    workspaceScope: ReturnType<typeof sql.string>;
    limit: ReturnType<typeof sql.number>;
  };
  workspaceScope: string;
}) {
  const genieReturn = useAnalyticsQuery('roi_genie_return_kpis', rangeParams);
  const genieInvest = useAnalyticsQuery('roi_genie_investment_kpis', rangeParams);
  const genieSpaces = useAnalyticsQuery('roi_genie_return_spaces', limited);
  const genieAllowanceParams = useMemo(
    () => ({
      workspaceScope: sql.string(workspaceScope),
      limit: sql.number(COMPACT_LIST_FETCH_LIMIT),
    }),
    [workspaceScope],
  );
  const genieAllowance = useAnalyticsQuery('roi_genie_user_allowance', genieAllowanceParams);
  const returnRow = genieReturn.data?.[0];
  const investRow = genieInvest.data?.[0];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold text-foreground">Genie: conversations versus investment</h3>
        <p className="text-sm text-muted-foreground">
          Return is conversation activity from Genie Agent audit. Investment is Genie billing: Databricks-funded free
          DBUs versus billed DBUs. Never read Genie list spend without this split.
        </p>
      </div>
      <Alert>
        <AlertTitle>Databricks-funded Genie usage</AlertTitle>
        <AlertDescription>
          <p>
            Each user (not service principals) gets <strong>150 DBUs of Genie Code free</strong> every calendar month.
            The allowance resets on the 1st. Through <strong>January 31, 2027</strong>, Genie One and Genie Agents
            usage by users is also free and does not consume the 150 DBU Code allowance. Service principal usage is
            billed.
          </p>
          <p className="mt-2">
            Free rows use SKU <code>GENIE_FREE_USAGE</code>, which has no list price — $0 attributed spend on those
            rows is expected, not missing cost. Billed Genie (Genie Code above 150 DBUs, and any service principal
            usage) meters on the shared Serverless Real-Time Inference SKU; this app isolates it with{' '}
            <code>billing_origin_product = GENIE</code>. A 25% promotional discount on billed Genie is already in the
            DBU quantity through January 31, 2027.
          </p>
        </AlertDescription>
      </Alert>
      <KpiGrid
        items={[
          {
            title: 'Genie messages',
            value: genieReturn.loading ? '…' : formatNumber(returnRow?.message_events),
            unit: 'start + create conversation messages',
            period,
            source: 'aibiGenie audit via genie_activity_daily',
          },
          {
            title: 'Genie users and spaces',
            value: genieReturn.loading
              ? '…'
              : `${formatNumber(returnRow?.active_users)} · ${formatNumber(returnRow?.space_count)}`,
            unit: 'email users · spaces with activity',
            period,
            source: 'aibiGenie audit via genie_activity_daily',
          },
          {
            title: 'Databricks-funded Genie DBUs',
            value: genieInvest.loading ? '…' : formatNumber(investRow?.free_dbus),
            unit: genieInvest.loading
              ? 'GENIE_FREE_USAGE — not billed'
              : `GENIE_FREE_USAGE — not billed; ~${formatCurrency(investRow?.estimated_free_list_cost)} list equivalent at Code rate`,
            period,
            source: 'system.billing.usage',
          },
          {
            title: 'Billed Genie investment',
            value: genieInvest.loading ? '…' : formatCurrency(investRow?.paid_list_cost),
            unit: genieInvest.loading ? 'billed DBUs at list' : `${formatNumber(investRow?.paid_dbus)} billed DBUs at list`,
            period,
            source: 'system.billing.usage × list_prices',
          },
          {
            title: 'Billed spend per question',
            value:
              genieReturn.loading || genieInvest.loading
                ? '…'
                : toNumber(returnRow?.message_events) === 0
                  ? '—'
                  : formatCurrency(toNumber(investRow?.paid_list_cost) / toNumber(returnRow?.message_events), 2),
            unit: 'list $ per conversation message; GENIE_FREE_USAGE is $0',
            period,
            source: 'genie_activity_daily + GENIE billing',
          },
        ]}
      />
      {genieReturn.error || genieInvest.error ? (
        <p className="text-sm text-destructive">
          Partial permission: Genie KPI queries failed. Space and allowance panels still render if granted.
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Genie conversations (return)</CardTitle>
            <CardDescription>
              Daily conversation messages and users from Genie Agent audit. Feedback is thumbs on answers, not cost.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              queryKey="roi_genie_return_trend"
              parameters={rangeParams}
              format="json"
              colorPalette="categorical"
              xKey="activity_date"
              yKey={['message_events', 'active_users', 'feedback_events']}
              height={280}
              ariaLabel="Genie conversation return over time"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Genie investment (free vs billed)</CardTitle>
            <CardDescription>
              Daily DBUs on GENIE_FREE_USAGE versus billed Serverless Real-Time Inference. Free SKU has no dollar
              list price.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              queryKey="roi_genie_investment_trend"
              parameters={rangeParams}
              format="json"
              stacked
              colorPalette="categorical"
              xKey="usage_date"
              yKey={['free_dbus', 'paid_dbus']}
              height={280}
              ariaLabel="Genie free versus billed DBUs"
            />
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Genie spaces by conversations</CardTitle>
            <CardDescription>Open a space to inspect return. Message counts are the value side of ROI.</CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={genieSpaces.loading}
              error={genieSpaces.error}
              rows={genieSpaces.data ?? []}
              emptyTitle="No Genie conversation activity"
              emptyDescription="No aibiGenie audit rows matched this date and workspace filter, or the 90-day Genie MV is not ready."
              searchLabel="Filter Genie spaces"
              searchPlaceholder="Space ID"
              getSearchText={(row) => row.space_id}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Space</TableHead>
                      <TableHead>Messages</TableHead>
                      <TableHead>Users</TableHead>
                      <TableHead>Feedback</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.space_id}`}>
                        <TableCell>
                          <WorkspaceLink href={genieSpaceUrl(host, row.space_id, row.workspace_id)}>
                            {row.space_id}
                          </WorkspaceLink>
                        </TableCell>
                        <TableCell>{formatNumber(row.message_events)}</TableCell>
                        <TableCell>{formatNumber(row.active_users)}</TableCell>
                        <TableCell>{formatNumber(row.feedback_events)}</TableCell>
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
            <CardTitle>Current-month Code allowance</CardTitle>
            <CardDescription>
              This table is the current calendar month, not the date filter. 150 free DBUs apply to Genie Code only.
              Genie One and Agents user usage is promotional-free through January 31, 2027 and does not consume the
              150.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={genieAllowance.loading}
              error={genieAllowance.error}
              rows={genieAllowance.data ?? []}
              emptyTitle="No Genie billing this month"
              emptyDescription="No GENIE usage rows in the current calendar month, or billing system tables are not visible."
              searchLabel="Filter principals"
              searchPlaceholder="Principal or allowance band"
              getSearchText={(row) => `${row.run_as} ${row.principal_kind} ${row.allowance_band}`}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Principal</TableHead>
                      <TableHead>Code free remaining</TableHead>
                      <TableHead>One / Agents free</TableHead>
                      <TableHead>Billed DBUs</TableHead>
                      <TableHead>Allowance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.workspace_id}-${row.run_as}`}>
                        <TableCell>
                          {row.run_as}
                          <div className="text-xs text-muted-foreground">{row.principal_kind}</div>
                        </TableCell>
                        <TableCell>
                          {row.principal_kind === 'user'
                            ? `${formatNumber(row.genie_code_free_dbus_remaining)} of 150`
                            : 'None'}
                          <div className="text-xs text-muted-foreground">
                            {formatNumber(row.genie_code_free_dbus)} Code free used
                          </div>
                        </TableCell>
                        <TableCell>
                          {formatNumber(Number(row.genie_one_free_dbus) + Number(row.genie_agents_free_dbus))}
                        </TableCell>
                        <TableCell>{formatNumber(row.paid_dbus)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.allowance_band === 'within_code_allowance'
                                ? 'secondary'
                                : row.allowance_band === 'code_allowance_used' ||
                                    row.allowance_band === 'no_user_allowance'
                                  ? 'destructive'
                                  : 'outline'
                            }
                          >
                            {genieAllowanceLabel(row.allowance_band)}
                          </Badge>
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
    </div>
  );
}

function JobRoiTable({
  rows,
  host,
  loading,
  error,
  emptyTitle,
  emptyDescription,
}: {
  rows: Array<{
    workspace_id: string;
    job_id: string;
    job_name: string;
    run_as: string;
    list_cost: number;
    runs: number;
    produced_tables: number;
    downstream_consumers: number;
    notebook_consumers: number;
    dashboard_consumers: number;
    sql_query_consumers: number;
    pipeline_consumers: number;
    query_or_agent_consumers: number;
    roi_band: string;
  }>;
  host: string | null;
  loading: boolean;
  error: string | null;
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <FilteredTable
      loading={loading}
      error={error}
      rows={rows}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      searchLabel="Filter jobs"
      searchPlaceholder="Job name or run-as"
      getSearchText={(row) => `${row.job_name} ${row.run_as} ${row.roi_band}`}
    >
      {(pageRows) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Attributed spend</TableHead>
              <TableHead>Downstream</TableHead>
              <TableHead>ROI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((row) => (
              <TableRow key={`${row.workspace_id}-${row.job_id}`}>
                <TableCell>
                  <WorkspaceLink href={jobUrl(host, row.job_id)}>{row.job_name}</WorkspaceLink>
                  <div className="text-xs text-muted-foreground">{row.run_as}</div>
                </TableCell>
                <TableCell>
                  {formatCurrency(row.list_cost)}
                  <div className="text-xs text-muted-foreground">{formatNumber(row.runs)} runs</div>
                </TableCell>
                <TableCell>
                  {formatNumber(row.downstream_consumers)}
                  <div className="text-xs text-muted-foreground">
                    {formatNumber(row.produced_tables)} tables · {formatNumber(row.notebook_consumers)} nb ·{' '}
                    {formatNumber(row.dashboard_consumers)} dash · {formatNumber(row.sql_query_consumers)} sql
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={row.roi_band === 'cost_with_use' ? 'secondary' : 'destructive'}>
                    {roiBandLabel(row.roi_band)}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </FilteredTable>
  );
}

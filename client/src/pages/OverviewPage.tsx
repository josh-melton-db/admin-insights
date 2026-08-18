import { useMemo } from 'react';
import { Link, useOutletContext } from 'react-router';
import { sql } from '@databricks/appkit-ui/js';
import {
  Badge,
  BarChart,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LineChart,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import { useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { FilterBar } from '@/components/FilterBar';
import { FilteredTable } from '@/components/FilteredTable';
import { KpiGrid } from '@/components/KpiGrid';
import { ReadinessPanel } from '@/components/ReadinessPanel';
import { formatCurrency, formatNumber } from '@/lib/formatters';
import type { AdminOutletContext } from '@/lib/outlet';

export function OverviewPage() {
  const { filters, setFilters, identity, summary } = useOutletContext<AdminOutletContext>();
  const rangeParams = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
    }),
    [filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const estateParams = useMemo(
    () => ({
      ...rangeParams,
      catalogPattern: sql.string(filters.catalogPattern || '%'),
    }),
    [filters.catalogPattern, rangeParams],
  );
  const serviceParams = useMemo(() => ({ ...rangeParams, limit: sql.number(12) }), [rangeParams]);
  const roi = useAnalyticsQuery('roi_overview_kpis', estateParams);
  const sqlActivity = useAnalyticsQuery('roi_sql_activity_kpis', rangeParams);
  const genieReturn = useAnalyticsQuery('roi_genie_return_kpis', rangeParams);
  const genieInvest = useAnalyticsQuery('roi_genie_investment_kpis', rangeParams);
  const period = `${filters.startDate} to ${filters.endDate}`;
  const roiRow = roi.data?.[0];
  const sqlRow = sqlActivity.data?.[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Admin Insights overview</h2>
          <p className="text-sm text-muted-foreground">
            Signed in as {identity?.actor.email ?? 'unknown'} · execution {identity?.runtime.executionMode ?? 'dry_run'}.
            Active users come from workspace audit, not SQL query history. Return includes tables, jobs, serving
            endpoints, and models — queries are one activity stream, not the definition of value.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="secondary">{identity?.actor.isAdmin ? 'Administrator' : 'Restricted'}</Badge>
          <Badge variant="outline">{summary?.pendingRequests ?? 0} pending requests</Badge>
        </div>
      </div>
      <FilterBar filters={filters} onChange={setFilters} />
      <KpiGrid
        items={[
          {
            title: 'Active users',
            value: roi.loading ? '…' : formatNumber(roiRow?.active_users),
            unit: 'email principals in audit',
            period,
            source: 'access.audit via actor_activity_daily',
          },
          {
            title: 'Tables managed',
            value: roi.loading ? '…' : formatNumber(roiRow?.table_count),
            unit: 'UC tables, views, MVs, and metric views',
            period,
            source: 'information_schema.tables',
          },
          {
            title: 'Jobs',
            value: roi.loading ? '…' : formatNumber(roiRow?.job_count),
            unit: 'active job definitions',
            period,
            source: 'system.lakeflow.jobs',
          },
          {
            title: 'Serving endpoints',
            value: roi.loading ? '…' : formatNumber(roiRow?.serving_endpoint_count),
            unit: roi.loading
              ? 'excluding databricks-%'
              : `${formatNumber(roiRow?.serving_always_on_count)} always on · ${formatNumber(roiRow?.serving_scale_to_zero_count)} scale to zero`,
            period,
            source: 'system.serving.served_entities',
          },
          {
            title: 'Models served',
            value: roi.loading ? '…' : formatNumber(roiRow?.managed_model_count),
            unit: 'custom and external models',
            period,
            source: 'system.serving.served_entities',
          },
          {
            title: 'Service principals',
            value: roi.loading ? '…' : formatNumber(roiRow?.active_service_principals),
            unit: 'UUID principals in audit',
            period,
            source: 'access.audit via actor_activity_daily',
          },
          {
            title: 'SQL rows processed',
            value: sqlActivity.loading ? '…' : formatNumber(Number(sqlRow?.rows_read ?? 0) + Number(sqlRow?.rows_returned ?? 0)),
            unit: 'read + produced in SQL; estate row counts are not collected',
            period,
            source: 'system.query.history',
          },
        ]}
      />
      {(roi.error || sqlActivity.error || genieReturn.error || genieInvest.error) && (
        <p className="text-sm text-destructive">
          Partial permission: {roi.error || sqlActivity.error || genieReturn.error || genieInvest.error}.
          Other tiles remain available.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Genie: conversations versus Databricks-funded usage</CardTitle>
          <CardDescription>
            Each user gets 150 free Genie Code DBUs per month. Through January 31, 2027, user Genie One and Agents
            usage is also Databricks-funded. Service principals are billed.{' '}
            <Link to="/cost" className="text-primary underline-offset-4 hover:underline">
              Open ROI for spaces and allowances
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-sm text-muted-foreground">Messages (return)</p>
              <p className="text-2xl font-semibold text-foreground">
                {genieReturn.loading ? '…' : formatNumber(genieReturn.data?.[0]?.message_events)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Genie users · spaces</p>
              <p className="text-2xl font-semibold text-foreground">
                {genieReturn.loading
                  ? '…'
                  : `${formatNumber(genieReturn.data?.[0]?.active_users)} · ${formatNumber(genieReturn.data?.[0]?.space_count)}`}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Databricks-funded DBUs</p>
              <p className="text-2xl font-semibold text-foreground">
                {genieInvest.loading ? '…' : formatNumber(genieInvest.data?.[0]?.free_dbus)}
              </p>
              <p className="text-xs text-muted-foreground">GENIE_FREE_USAGE — $0 list is expected</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Billed Genie investment</p>
              <p className="text-2xl font-semibold text-foreground">
                {genieInvest.loading ? '…' : formatCurrency(genieInvest.data?.[0]?.paid_list_cost)}
              </p>
              <p className="text-xs text-muted-foreground">
                {genieInvest.loading ? '…' : `${formatNumber(genieInvest.data?.[0]?.paid_dbus)} billed DBUs`}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Active users over time</CardTitle>
            <CardDescription>
              Distinct email principals and service principals from workspace audit, all services.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LineChart
              queryKey="roi_user_activity_trend"
              parameters={rangeParams}
              format="json"
              colorPalette="categorical"
              xKey="activity_date"
              yKey={['active_users', 'active_service_principals']}
              height={280}
              ariaLabel="Active users from audit"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Attributed spend over time</CardTitle>
            <CardDescription>USD list and DBUs from billing usage — inspect ROI for return or action</CardDescription>
          </CardHeader>
          <CardContent>
            <LineChart
              queryKey="cost_trend"
              parameters={rangeParams}
              format="json"
              colorPalette="categorical"
              xKey="usage_date"
              yKey={['list_cost', 'dbus']}
              height={280}
              ariaLabel="Attributed spend trend"
            />
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Users by service</CardTitle>
            <CardDescription>Audit actors grouped by Databricks service — jobs, SQL, serving, UC, apps, and more</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              queryKey="roi_users_by_service"
              parameters={serviceParams}
              format="json"
              colorPalette="categorical"
              xKey="service_name"
              yKey="active_users"
              height={280}
              ariaLabel="Active users by audit service"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>SQL query activity</CardTitle>
            <CardDescription>SQL only, from query history. Not a workspace user count.</CardDescription>
          </CardHeader>
          <CardContent>
            <LineChart
              queryKey="roi_query_trend"
              parameters={rangeParams}
              format="json"
              colorPalette="categorical"
              xKey="query_date"
              yKey={['query_count', 'distinct_users']}
              height={280}
              ariaLabel="SQL query activity trend"
            />
          </CardContent>
        </Card>
      </div>
      <OverviewTables params={rangeParams} />
      <ReadinessPanel />
    </div>
  );
}

function OverviewTables({
  params,
}: {
  params: { startDate: ReturnType<typeof sql.date>; endDate: ReturnType<typeof sql.date>; workspaceScope: ReturnType<typeof sql.string> };
}) {
  const clients = useAnalyticsQuery('roi_client_applications', {
    ...params,
    limit: sql.number(50),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>SQL client applications</CardTitle>
        <CardDescription>Who ran SQL, by client application. Complements audit users; it is not the full workspace population.</CardDescription>
      </CardHeader>
      <CardContent>
        <FilteredTable
          loading={clients.loading}
          error={clients.error}
          rows={clients.data ?? []}
          emptyTitle="No SQL client activity"
          emptyDescription="No query history rows matched this date and workspace filter."
          searchLabel="Filter SQL clients"
          searchPlaceholder="Client application"
          getSearchText={(row) => row.client_application}
        >
          {(pageRows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Queries</TableHead>
                  <TableHead>SQL users</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => (
                  <TableRow key={row.client_application}>
                    <TableCell>{row.client_application}</TableCell>
                    <TableCell>{formatNumber(row.query_count)}</TableCell>
                    <TableCell>{formatNumber(row.distinct_users)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </FilteredTable>
      </CardContent>
    </Card>
  );
}

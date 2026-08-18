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
import { ALL_FILTER, COMPACT_LIST_FETCH_LIMIT, scaleToZeroLabel, scaleToZeroListFilter, uniqueFilterOptions } from '@/lib/list-controls';
import { formatGranteeKind } from '@/lib/privileges';
import type { AdminFilters } from '@/lib/filters';
import { servingEndpointUrl } from '@/lib/workspace-links';

export function TaggedSpendPanel({ filters }: { filters: AdminFilters }) {
  const rangeParams = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
    }),
    [filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const limited = useMemo(() => ({ ...rangeParams, limit: sql.number(COMPACT_LIST_FETCH_LIMIT) }), [rangeParams]);
  const share = useAnalyticsQuery('cost_tagged_share', rangeParams);
  const byTag = useAnalyticsQuery('cost_by_tag', limited);
  const byWorkspace = useAnalyticsQuery('cost_by_workspace', limited);
  const byIdentity = useAnalyticsQuery('cost_by_identity', limited);
  const period = `${filters.startDate} to ${filters.endDate}`;
  const taggedShare = toNumber(share.data?.[0]?.tagged_share);
  const taggedCost = toNumber(share.data?.[0]?.tagged_cost);
  const untaggedCost = toNumber(share.data?.[0]?.untagged_cost);

  return (
    <div className="space-y-4">
      <KpiGrid
        items={[
          {
            title: 'Tagged spend share',
            value: share.loading ? '…' : formatPercent(taggedShare * 100),
            unit: 'of list-price spend with at least one custom tag',
            period,
            source: 'billing.usage custom_tags',
          },
          {
            title: 'Tagged list spend',
            value: share.loading ? '…' : formatCurrency(taggedCost),
            unit: 'USD list with custom tags',
            period,
            source: 'billing.usage custom_tags',
          },
          {
            title: 'Untagged list spend',
            value: share.loading ? '…' : formatCurrency(untaggedCost),
            unit: 'USD list with no custom tags',
            period,
            source: 'billing.usage custom_tags',
          },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spend by tag</CardTitle>
            <CardDescription>
              List-price spend exploded by custom tag. Untagged cost is the remainder in the KPI above.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={byTag.loading}
              error={byTag.error}
              rows={byTag.data ?? []}
              emptyTitle="No tagged spend"
              emptyDescription="No billing rows in this window had custom tags."
              searchLabel="Filter tags"
              searchPlaceholder="Tag key or value"
              getSearchText={(row) => `${row.tag_key} ${row.tag_value}`}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tag</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Spend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.tag_key}-${row.tag_value}`}>
                        <TableCell>{row.tag_key}</TableCell>
                        <TableCell>{row.tag_value}</TableCell>
                        <TableCell>{formatCurrency(row.list_cost)}</TableCell>
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
            <CardTitle>Spend by workspace</CardTitle>
            <CardDescription>Highest-spend workspaces in this window — Governance Hub Cost “top groups”.</CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={byWorkspace.loading}
              error={byWorkspace.error}
              rows={byWorkspace.data ?? []}
              emptyTitle="No workspace spend"
              emptyDescription="No billing rows matched this workspace scope."
              searchLabel="Filter workspaces"
              searchPlaceholder="Workspace name or ID"
              getSearchText={(row) => `${row.workspace_name} ${row.workspace_id}`}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workspace</TableHead>
                      <TableHead>Spend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={row.workspace_id}>
                        <TableCell>
                          {row.workspace_name}
                          <div className="text-xs text-muted-foreground">{row.workspace_id}</div>
                        </TableCell>
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
      <Card>
        <CardHeader>
          <CardTitle>Spend by identity</CardTitle>
          <CardDescription>Run-as / created-by principals driving list-price spend in this window.</CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={byIdentity.loading}
            error={byIdentity.error}
            rows={byIdentity.data ?? []}
            emptyTitle="No identity-attributed spend"
            emptyDescription="Billing identity_metadata was empty for this window."
            searchLabel="Filter identities"
            searchPlaceholder="User or service principal"
            getSearchText={(row) => row.identity}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Identity</TableHead>
                    <TableHead>Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={row.identity}>
                      <TableCell>{row.identity}</TableCell>
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
  );
}

export function AiUsagePanel({ filters, host }: { filters: AdminFilters; host: string | null }) {
  const limited = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
      limit: sql.number(COMPACT_LIST_FETCH_LIMIT),
    }),
    [filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const models = useAnalyticsQuery('ai_active_models', limited);
  const users = useAnalyticsQuery('ai_active_users', limited);
  const requesterOptions = useMemo(
    () => uniqueFilterOptions((users.data ?? []).map((row) => formatGranteeKind(row.requester_kind)), 'All requesters'),
    [users.data],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Active models</CardTitle>
          <CardDescription>
            Serving entities with the most requests in this window. Filter by scale to zero. Open an endpoint to
            inspect traffic or add inference logging.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={models.loading}
            error={models.error}
            rows={models.data ?? []}
            emptyTitle="No model serving requests"
            emptyDescription="system.serving.endpoint_usage had no rows in this window."
            searchLabel="Filter models"
            searchPlaceholder="Endpoint or model"
            getSearchText={(row) =>
              `${row.endpoint_name} ${row.model_name} ${row.entity_type} ${scaleToZeroLabel(row.scale_to_zero_band)}`
            }
            filters={[scaleToZeroListFilter('Active models scale to zero')]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Scale</TableHead>
                    <TableHead>Requests</TableHead>
                    <TableHead>Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.endpoint_name}-${row.model_name}`}>
                      <TableCell>
                        <WorkspaceLink href={servingEndpointUrl(host, row.endpoint_name)}>{row.model_name}</WorkspaceLink>
                        <div className="text-xs text-muted-foreground">
                          {row.endpoint_name}
                          {row.entity_type ? ` · ${row.entity_type}` : ''}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.scale_to_zero_band === 'does_not_scale_to_zero' ? 'secondary' : 'outline'}>
                          {scaleToZeroLabel(row.scale_to_zero_band)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {formatNumber(row.request_count)}
                        <div className="text-xs text-muted-foreground">
                          {formatNumber(row.requester_count)} requesters
                        </div>
                      </TableCell>
                      <TableCell>
                        {formatNumber(toNumber(row.input_tokens) + toNumber(row.output_tokens))}
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
          <CardTitle>Active serving requesters</CardTitle>
          <CardDescription>Users and service principals generating model-serving traffic.</CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={users.loading}
            error={users.error}
            rows={users.data ?? []}
            emptyTitle="No serving requesters"
            emptyDescription="No endpoint_usage requesters in this window."
            searchLabel="Filter requesters"
            searchPlaceholder="User or service principal"
            getSearchText={(row) => `${row.requester} ${row.requester_kind}`}
            filters={[
              {
                id: 'kind',
                label: 'Requester type',
                options: requesterOptions,
                match: (row, value) => value === ALL_FILTER || formatGranteeKind(row.requester_kind) === value,
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requester</TableHead>
                    <TableHead>Requests</TableHead>
                    <TableHead>Models</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={row.requester}>
                      <TableCell>
                        {row.requester}
                        <div className="text-xs text-muted-foreground">
                          <Badge variant="outline">{formatGranteeKind(row.requester_kind)}</Badge>
                        </div>
                      </TableCell>
                      <TableCell>{formatNumber(row.request_count)}</TableCell>
                      <TableCell>{formatNumber(row.model_count)}</TableCell>
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

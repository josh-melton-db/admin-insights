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
import { formatNumber } from '@/lib/formatters';
import { ALL_FILTER, COMPACT_LIST_FETCH_LIMIT, uniqueFilterOptions } from '@/lib/list-controls';
import type { AdminFilters } from '@/lib/filters';
import { tableExplorerUrl } from '@/lib/workspace-links';

export function GovernanceTagsPanel({
  filters,
  host,
}: {
  filters: AdminFilters;
  host: string | null;
}) {
  const catalogParams = useMemo(
    () => ({ catalogPattern: sql.string(filters.catalogPattern || '%') }),
    [filters.catalogPattern],
  );
  const limitedCatalog = useMemo(
    () => ({ ...catalogParams, limit: sql.number(COMPACT_LIST_FETCH_LIMIT) }),
    [catalogParams],
  );
  const popularParams = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
      catalogPattern: sql.string(filters.catalogPattern || '%'),
      limit: sql.number(COMPACT_LIST_FETCH_LIMIT),
    }),
    [filters.catalogPattern, filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const governed = useAnalyticsQuery('governed_tags', { limit: sql.number(COMPACT_LIST_FETCH_LIMIT) });
  const usage = useAnalyticsQuery('governed_tag_usage', limitedCatalog);
  const assignments = useAnalyticsQuery('tagged_objects', limitedCatalog);
  const untagged = useAnalyticsQuery('popular_untagged_tables', popularParams);
  const period = `${filters.startDate} to ${filters.endDate}`;
  const governedCount = governed.data?.length ?? 0;
  const assignmentCount = (usage.data ?? []).reduce((sum, row) => sum + Number(row.assignment_count ?? 0), 0);
  const coverageOptions = useMemo(
    () =>
      uniqueFilterOptions(
        (usage.data ?? []).map((row) => (row.is_governed ? 'Governed' : 'Ungoverned')),
        'All tag keys',
      ),
    [usage.data],
  );

  return (
    <div className="space-y-4">
      <KpiGrid
        items={[
          {
            title: 'Governed tag keys',
            value: governed.loading ? '…' : formatNumber(governedCount),
            unit: 'active keys in system.tags.governed_tags',
            period: 'current',
            source: 'system.tags.governed_tags',
          },
          {
            title: 'Tag assignments in scope',
            value: usage.loading ? '…' : formatNumber(assignmentCount),
            unit: 'catalog, schema, table, and column tags',
            period: 'current',
            source: 'information_schema *_tags',
          },
          {
            title: 'Untagged popular tables',
            value: untagged.loading ? '…' : formatNumber(untagged.data?.length ?? 0),
            unit: 'most-read tables with no table-level tag',
            period,
            source: 'table_lineage anti-join table_tags',
          },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>Governed tags</CardTitle>
          <CardDescription>
            Account governed tag keys that are not deleted. Assignments in this catalog pattern are ranked below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={governed.loading}
            error={governed.error}
            rows={governed.data ?? []}
            emptyTitle="No governed tags"
            emptyDescription="system.tags.governed_tags is empty or not visible to the signed-in user."
            searchLabel="Filter governed tags"
            searchPlaceholder="Tag key"
            getSearchText={(row) => row.tag_key}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tag key</TableHead>
                    <TableHead>Last changed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={row.tag_key}>
                      <TableCell>{row.tag_key}</TableCell>
                      <TableCell>{String(row.last_changed).slice(0, 10)}</TableCell>
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
          <CardTitle>Governed tag usage</CardTitle>
          <CardDescription>
            Tag keys ranked by how many Unity Catalog assets they are assigned to. Governed keys are flagged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={usage.loading}
            error={usage.error}
            rows={usage.data ?? []}
            emptyTitle="No tag assignments"
            emptyDescription="No catalog, schema, table, or column tags matched this catalog pattern."
            searchLabel="Filter tag usage"
            searchPlaceholder="Tag key"
            getSearchText={(row) => row.tag_name}
            filters={[
              {
                id: 'governed',
                label: 'Coverage',
                options: coverageOptions,
                match: (row, value) =>
                  value === ALL_FILTER || (row.is_governed ? 'Governed' : 'Ungoverned') === value,
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tag</TableHead>
                    <TableHead>Assignments</TableHead>
                    <TableHead>Catalogs</TableHead>
                    <TableHead>Governed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={row.tag_name}>
                      <TableCell>{row.tag_name}</TableCell>
                      <TableCell>{formatNumber(row.assignment_count)}</TableCell>
                      <TableCell>{formatNumber(row.catalog_count)}</TableCell>
                      <TableCell>
                        <Badge variant={row.is_governed ? 'secondary' : 'outline'}>
                          {row.is_governed ? 'Governed' : 'Ungoverned'}
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
      <Card>
        <CardHeader>
          <CardTitle>Popular tables missing tags</CardTitle>
          <CardDescription>
            Tables with the most lineage readers in this window and no table-level tag. Tag them so cost and access
            policies can attribute use.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={untagged.loading}
            error={untagged.error}
            rows={untagged.data ?? []}
            emptyTitle="No untagged popular tables"
            emptyDescription="Every heavily read table in this window has a table tag, or lineage is not visible."
            searchLabel="Filter untagged tables"
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
          <CardTitle>Tag assignments on objects</CardTitle>
          <CardDescription>Catalog, schema, table, and column tags currently assigned in this catalog pattern.</CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={assignments.loading}
            error={assignments.error}
            rows={assignments.data ?? []}
            emptyTitle="No tags found"
            emptyDescription="No catalog, schema, table, or column tags matched this filter."
            searchLabel="Filter tag assignments"
            searchPlaceholder="Object, tag, or value"
            getSearchText={(row) =>
              `${row.object_type} ${row.catalog_name} ${row.schema_name} ${row.object_name} ${row.tag_name} ${row.tag_value}`
            }
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Catalog</TableHead>
                    <TableHead>Object</TableHead>
                    <TableHead>Tag</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow
                      key={`${row.object_type}-${row.catalog_name}-${row.schema_name}-${row.object_name}-${row.tag_name}-${row.tag_value}`}
                    >
                      <TableCell>{row.object_type}</TableCell>
                      <TableCell>{row.catalog_name}</TableCell>
                      <TableCell>{row.object_name ?? row.schema_name ?? '—'}</TableCell>
                      <TableCell>{row.tag_name}</TableCell>
                      <TableCell>{row.tag_value}</TableCell>
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

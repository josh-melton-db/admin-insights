import { useEffect, useMemo, useState } from 'react';
import { sql } from '@databricks/appkit-ui/js';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
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
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { formatNumber } from '@/lib/formatters';
import { COMPACT_LIST_FETCH_LIMIT, LIST_FETCH_LIMIT } from '@/lib/list-controls';
import { tableUrlFromFullName } from '@/lib/workspace-links';

type LineagePair = {
  source_type: string;
  target_type: string;
  source_table_catalog: string;
  target_table_catalog: string;
};

function typeLabel(value: string | null | undefined): string {
  return value ? value : 'None';
}

function catalogLabel(value: string | null | undefined): string {
  return value ? value : 'None';
}

function pairLabel(pair: LineagePair): string {
  return `${typeLabel(pair.source_type)} → ${typeLabel(pair.target_type)}`;
}

export function LineageExplorer({
  startDate,
  endDate,
  workspaceScope,
  catalogPattern,
  host,
}: {
  startDate: string;
  endDate: string;
  workspaceScope: string;
  catalogPattern: string;
  host: string | null;
}) {
  const [selected, setSelected] = useState<LineagePair | null>(null);

  useEffect(() => {
    setSelected(null);
  }, [catalogPattern, endDate, startDate, workspaceScope]);

  const summaryParams = useMemo(
    () => ({
      startDate: sql.date(startDate),
      endDate: sql.date(endDate),
      workspaceScope: sql.string(workspaceScope),
      catalogPattern: sql.string(catalogPattern || '%'),
      limit: sql.number(COMPACT_LIST_FETCH_LIMIT),
    }),
    [catalogPattern, endDate, startDate, workspaceScope],
  );
  const connectionParams = useMemo(
    () => ({
      startDate: sql.date(startDate),
      endDate: sql.date(endDate),
      workspaceScope: sql.string(workspaceScope),
      catalogPattern: sql.string(catalogPattern || '%'),
      sourceType: sql.string(selected?.source_type ?? ''),
      targetType: sql.string(selected?.target_type ?? ''),
      sourceCatalog: sql.string(selected?.source_table_catalog ?? ''),
      targetCatalog: sql.string(selected?.target_table_catalog ?? ''),
      limit: sql.number(LIST_FETCH_LIMIT),
    }),
    [catalogPattern, endDate, selected, startDate, workspaceScope],
  );

  const summary = useAnalyticsQuery('lineage_ingestion', summaryParams);
  const connections = useAnalyticsQuery('lineage_connections', connectionParams, {
    autoStart: Boolean(selected),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ingestion lineage</CardTitle>
        <CardDescription>
          Click a type pair to list every source → target connection, for example TABLE → METRIC_VIEW.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              {selected ? (
                <BreadcrumbLink asChild>
                  <button type="button" onClick={() => setSelected(null)}>
                    Type pairs
                  </button>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>Type pairs</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {selected ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{pairLabel(selected)}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        {selected ? (
          <>
            <h3 className="text-sm font-medium text-foreground">
              {pairLabel(selected)} from {catalogLabel(selected.source_table_catalog)} to{' '}
              {catalogLabel(selected.target_table_catalog)}
            </h3>
            <FilteredTable
              key={`${selected.source_type}-${selected.target_type}-${selected.source_table_catalog}-${selected.target_table_catalog}`}
              loading={connections.loading}
              error={connections.error}
              rows={connections.data ?? []}
              emptyTitle="No lineage connections"
              emptyDescription="No source → target objects matched this type pair in the selected range."
              searchLabel="Filter lineage connections"
              searchPlaceholder="Source or target object"
              getSearchText={(row) => `${row.source_name} ${row.target_name}`}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Events</TableHead>
                      <TableHead>Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => (
                      <TableRow key={`${row.source_name}-${row.target_name}`}>
                        <TableCell>
                          <LineageObject name={row.source_name} host={host} />
                        </TableCell>
                        <TableCell>
                          <LineageObject name={row.target_name} host={host} />
                        </TableCell>
                        <TableCell>{formatNumber(row.lineage_events)}</TableCell>
                        <TableCell>{row.last_event_time ? String(row.last_event_time) : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </FilteredTable>
          </>
        ) : (
          <FilteredTable
            key="type-pairs"
            loading={summary.loading}
            error={summary.error}
            rows={summary.data ?? []}
            emptyTitle="No lineage events"
            emptyDescription="No table lineage events in this date range."
            searchLabel="Filter lineage type pairs"
            searchPlaceholder="Source type, target type, or catalog"
            getSearchText={(row) =>
              `${row.source_type} ${row.target_type} ${row.source_table_catalog} ${row.target_table_catalog}`
            }
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type pair</TableHead>
                    <TableHead>Source catalog</TableHead>
                    <TableHead>Target catalog</TableHead>
                    <TableHead>Sources</TableHead>
                    <TableHead>Targets</TableHead>
                    <TableHead>Events</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow
                      key={`${row.source_type}-${row.target_type}-${row.source_table_catalog}-${row.target_table_catalog}`}
                    >
                      <TableCell>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-left"
                          onClick={() =>
                            setSelected({
                              source_type: row.source_type,
                              target_type: row.target_type,
                              source_table_catalog: row.source_table_catalog,
                              target_table_catalog: row.target_table_catalog,
                            })
                          }
                        >
                          {pairLabel(row)}
                        </Button>
                      </TableCell>
                      <TableCell>{catalogLabel(row.source_table_catalog)}</TableCell>
                      <TableCell>{catalogLabel(row.target_table_catalog)}</TableCell>
                      <TableCell>{formatNumber(row.distinct_sources)}</TableCell>
                      <TableCell>{formatNumber(row.distinct_targets)}</TableCell>
                      <TableCell>{formatNumber(row.lineage_events)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        )}
      </CardContent>
    </Card>
  );
}

function LineageObject({ name, host }: { name: string; host: string | null }) {
  if (!name) {
    return <>None</>;
  }
  const href = tableUrlFromFullName(host, name);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>{name}</span>
      {href ? <WorkspaceLink href={href}>Open</WorkspaceLink> : null}
    </div>
  );
}

import { useMemo, useState } from 'react';
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
import { catalogExplorerUrl, schemaExplorerUrl, tableExplorerUrl } from '@/lib/workspace-links';

type ObjectPath =
  | { level: 'catalogs' }
  | { level: 'schemas'; catalogName: string }
  | { level: 'tables'; catalogName: string; schemaName: string };

export function ObjectExplorer({
  catalogPattern,
  host,
}: {
  catalogPattern: string;
  host: string | null;
}) {
  const [path, setPath] = useState<ObjectPath>({ level: 'catalogs' });
  const catalogs = useAnalyticsQuery('object_catalogs', {
    catalogPattern: sql.string(catalogPattern || '%'),
    limit: sql.number(100),
  });
  const schemas = useAnalyticsQuery(
    'object_schemas',
    {
      catalogName: sql.string(path.level === 'catalogs' ? '' : path.catalogName),
      limit: sql.number(100),
    },
    { autoStart: path.level === 'schemas' },
  );
  const tables = useAnalyticsQuery(
    'object_tables',
    {
      catalogName: sql.string(path.level === 'tables' ? path.catalogName : ''),
      schemaName: sql.string(path.level === 'tables' ? path.schemaName : ''),
      limit: sql.number(100),
    },
    { autoStart: path.level === 'tables' },
  );

  const title = useMemo(() => {
    if (path.level === 'tables') {
      return `Tables in ${path.catalogName}.${path.schemaName}`;
    }
    if (path.level === 'schemas') {
      return `Schemas in ${path.catalogName}`;
    }
    return 'Catalogs';
  }, [path]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unity Catalog objects</CardTitle>
        <CardDescription>
          Click a catalog to open its schemas, then a schema to open its tables. Grant counts are
          direct ACL entries on that object, split into users versus groups (service principals are
          listed separately).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ObjectBreadcrumb path={path} onChange={setPath} />
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {path.level === 'catalogs' ? (
          <FilteredTable
            key="catalogs"
            loading={catalogs.loading}
            error={catalogs.error}
            rows={catalogs.data ?? []}
            emptyTitle="No catalogs visible"
            emptyDescription="The signed-in user cannot see any non-system catalogs matching this pattern."
            searchLabel="Filter catalogs"
            searchPlaceholder="Catalog, owner, or comment"
            getSearchText={(row) => `${row.catalog_name} ${row.catalog_owner} ${row.comment}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <GrantHeader nameLabel="Catalog" />
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={row.catalog_name}>
                      <TableCell>
                        <ObjectName
                          name={row.catalog_name}
                          href={catalogExplorerUrl(host, row.catalog_name)}
                          onOpen={() => setPath({ level: 'schemas', catalogName: row.catalog_name })}
                        />
                      </TableCell>
                      <TableCell>{row.catalog_owner || '—'}</TableCell>
                      <GrantCells
                        grantCount={row.grant_count}
                        userGrantCount={row.user_grant_count}
                        groupGrantCount={row.group_grant_count}
                        spGrantCount={row.sp_grant_count}
                      />
                      <TableCell>{row.comment || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        ) : null}
        {path.level === 'schemas' ? (
          <FilteredTable
            key={`schemas-${path.catalogName}`}
            loading={schemas.loading}
            error={schemas.error}
            rows={schemas.data ?? []}
            emptyTitle="No schemas visible"
            emptyDescription={`No schemas were returned for ${path.catalogName}.`}
            searchLabel="Filter schemas"
            searchPlaceholder="Schema, owner, or comment"
            getSearchText={(row) => `${row.schema_name} ${row.schema_owner} ${row.comment}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <GrantHeader nameLabel="Schema" />
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.catalog_name}.${row.schema_name}`}>
                      <TableCell>
                        <ObjectName
                          name={row.schema_name}
                          href={schemaExplorerUrl(host, row.catalog_name, row.schema_name)}
                          onOpen={() =>
                            setPath({
                              level: 'tables',
                              catalogName: row.catalog_name,
                              schemaName: row.schema_name,
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>{row.schema_owner || '—'}</TableCell>
                      <GrantCells
                        grantCount={row.grant_count}
                        userGrantCount={row.user_grant_count}
                        groupGrantCount={row.group_grant_count}
                        spGrantCount={row.sp_grant_count}
                      />
                      <TableCell>{row.comment || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        ) : null}
        {path.level === 'tables' ? (
          <FilteredTable
            key={`tables-${path.catalogName}.${path.schemaName}`}
            loading={tables.loading}
            error={tables.error}
            rows={tables.data ?? []}
            emptyTitle="No tables visible"
            emptyDescription={`No tables were returned for ${path.catalogName}.${path.schemaName}.`}
            searchLabel="Filter tables"
            searchPlaceholder="Table, type, owner, or comment"
            getSearchText={(row) => `${row.table_name} ${row.table_type} ${row.table_owner} ${row.comment}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Table</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Grants</TableHead>
                    <TableHead>Users</TableHead>
                    <TableHead>Groups</TableHead>
                    <TableHead>SPs</TableHead>
                    <TableHead>Comment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.catalog_name}.${row.schema_name}.${row.table_name}`}>
                      <TableCell>
                        <WorkspaceLink
                          href={tableExplorerUrl(host, row.catalog_name, row.schema_name, row.table_name)}
                        >
                          {row.table_name}
                        </WorkspaceLink>
                      </TableCell>
                      <TableCell>{row.table_type || '—'}</TableCell>
                      <TableCell>{row.table_owner || '—'}</TableCell>
                      <GrantCells
                        grantCount={row.grant_count}
                        userGrantCount={row.user_grant_count}
                        groupGrantCount={row.group_grant_count}
                        spGrantCount={row.sp_grant_count}
                      />
                      <TableCell>{row.comment || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ObjectBreadcrumb({
  path,
  onChange,
}: {
  path: ObjectPath;
  onChange: (path: ObjectPath) => void;
}) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {path.level === 'catalogs' ? (
            <BreadcrumbPage>Catalogs</BreadcrumbPage>
          ) : (
            <BreadcrumbLink asChild>
              <button type="button" onClick={() => onChange({ level: 'catalogs' })}>
                Catalogs
              </button>
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {path.level !== 'catalogs' ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {path.level === 'schemas' ? (
                <BreadcrumbPage>{path.catalogName}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <button
                    type="button"
                    onClick={() => onChange({ level: 'schemas', catalogName: path.catalogName })}
                  >
                    {path.catalogName}
                  </button>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </>
        ) : null}
        {path.level === 'tables' ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{path.schemaName}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function ObjectName({
  name,
  href,
  onOpen,
}: {
  name: string;
  href: string | null;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="link" className="h-auto p-0 text-left" onClick={onOpen}>
        {name}
      </Button>
      <WorkspaceLink href={href}>Open</WorkspaceLink>
    </div>
  );
}

function GrantHeader({ nameLabel }: { nameLabel: string }) {
  return (
    <TableRow>
      <TableHead>{nameLabel}</TableHead>
      <TableHead>Owner</TableHead>
      <TableHead>Grants</TableHead>
      <TableHead>Users</TableHead>
      <TableHead>Groups</TableHead>
      <TableHead>SPs</TableHead>
      <TableHead>Comment</TableHead>
    </TableRow>
  );
}

function GrantCells({
  grantCount,
  userGrantCount,
  groupGrantCount,
  spGrantCount,
}: {
  grantCount: number | string;
  userGrantCount: number | string;
  groupGrantCount: number | string;
  spGrantCount: number | string;
}) {
  return (
    <>
      <TableCell>{formatNumber(grantCount)}</TableCell>
      <TableCell>{formatNumber(userGrantCount)}</TableCell>
      <TableCell>{formatNumber(groupGrantCount)}</TableCell>
      <TableCell>{formatNumber(spGrantCount)}</TableCell>
    </>
  );
}

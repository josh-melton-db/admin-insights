import { Fragment, useEffect, useMemo, useState } from 'react';
import { sql } from '@databricks/appkit-ui/js';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { isNarrowCatalogPattern, toSqlLikeFilter } from '@/lib/filters';
import { formatNumber, toNumber } from '@/lib/formatters';
import {
  formatGranteeKind,
  GRANTEE_KIND_OPTIONS,
  parsePrivilegeList,
  PRIVILEGE_CLASS_ORDER,
  privilegeClassRank,
} from '@/lib/privileges';

const ALL = 'all';
const PREVIEW_PRIVILEGES = 3;

export function PrivilegeInventory({ catalogPattern }: { catalogPattern: string }) {
  const [catalogName, setCatalogName] = useState(ALL);
  const [schemaName, setSchemaName] = useState(ALL);
  const [tableName, setTableName] = useState(ALL);
  const [privilegeClass, setPrivilegeClass] = useState(ALL);
  const [granteeKind, setGranteeKind] = useState(ALL);
  const [granteeInput, setGranteeInput] = useState('');
  const [granteeFilter, setGranteeFilter] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setGranteeFilter(toSqlLikeFilter(granteeInput)), 400);
    return () => window.clearTimeout(timer);
  }, [granteeInput]);

  const selectedCatalog = catalogName === ALL ? '' : catalogName;
  const selectedSchema = schemaName === ALL ? '' : schemaName;
  const selectedTable = tableName === ALL ? '' : tableName;
  const includeObjects = Boolean(selectedCatalog) || isNarrowCatalogPattern(catalogPattern);

  const catalogs = useAnalyticsQuery('catalog_inventory', {
    catalogPattern: sql.string(catalogPattern || '%'),
    limit: sql.number(100),
  });
  const schemas = useAnalyticsQuery(
    'object_schemas',
    {
      catalogName: sql.string(selectedCatalog),
      limit: sql.number(100),
    },
    { autoStart: Boolean(selectedCatalog) },
  );
  const tables = useAnalyticsQuery(
    'object_tables',
    {
      catalogName: sql.string(selectedCatalog),
      schemaName: sql.string(selectedSchema),
      limit: sql.number(100),
    },
    { autoStart: Boolean(selectedCatalog && selectedSchema) },
  );

  const privilegeParams = useMemo(
    () => ({
      catalogPattern: sql.string(catalogPattern || '%'),
      catalogName: sql.string(selectedCatalog),
      schemaName: sql.string(selectedSchema),
      tableName: sql.string(selectedTable),
      granteeFilter: sql.string(granteeFilter),
      granteeKind: sql.string(granteeKind),
      privilegeClass: sql.string(privilegeClass),
      limit: sql.number(100),
    }),
    [catalogPattern, granteeFilter, granteeKind, privilegeClass, selectedCatalog, selectedSchema, selectedTable],
  );

  const privileges = useAnalyticsQuery('current_privilege_inventory', privilegeParams);
  const objectPrivileges = useAnalyticsQuery('current_object_privilege_inventory', privilegeParams, {
    autoStart: includeObjects,
  });
  const kindSummary = useAnalyticsQuery('privilege_kind_summary', {
    catalogPattern: sql.string(catalogPattern || '%'),
  });
  const topPrincipals = useAnalyticsQuery('privilege_top_principals', {
    catalogPattern: sql.string(catalogPattern || '%'),
    granteeKind: sql.string(granteeKind),
    limit: sql.number(100),
  });

  const rows = useMemo(() => {
    const merged = [...(privileges.data ?? []), ...(includeObjects ? (objectPrivileges.data ?? []) : [])];
    return merged.sort((left, right) => {
      const classDelta = privilegeClassRank(left.privilege_class) - privilegeClassRank(right.privilege_class);
      if (classDelta !== 0) {
        return classDelta;
      }
      return `${left.resource_name}\0${left.grantee}`.localeCompare(`${right.resource_name}\0${right.grantee}`);
    });
  }, [includeObjects, objectPrivileges.data, privileges.data]);

  const kindTotals = useMemo(() => {
    const totals = { user: 0, group: 0, service_principal: 0 };
    for (const row of kindSummary.data ?? []) {
      const grants = toNumber(row.grant_count);
      if (row.grantee_kind === 'user') {
        totals.user += grants;
      } else if (row.grantee_kind === 'group') {
        totals.group += grants;
      } else if (row.grantee_kind === 'service_principal') {
        totals.service_principal += grants;
      }
    }
    return totals;
  }, [kindSummary.data]);

  return (
    <div className="space-y-4">
      <KpiGrid
        items={[
          {
            title: 'User grants',
            value: kindSummary.loading ? '…' : formatNumber(kindTotals.user),
            unit: 'catalog/schema ACL entries granted to users',
            period: 'current grants',
            source: 'information_schema catalog and schema privileges',
          },
          {
            title: 'Group grants',
            value: kindSummary.loading ? '…' : formatNumber(kindTotals.group),
            unit: 'catalog/schema ACL entries granted to groups',
            period: 'current grants',
            source: 'information_schema catalog and schema privileges',
          },
          {
            title: 'Service principal grants',
            value: kindSummary.loading ? '…' : formatNumber(kindTotals.service_principal),
            unit: 'catalog/schema ACL entries granted to service principals',
            period: 'current grants',
            source: 'information_schema catalog and schema privileges',
          },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>Grants by principal type</CardTitle>
          <CardDescription>
            Direct catalog and schema grants, split into users, groups, and service principals. Table grants load below
            after you select a catalog.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={kindSummary.loading}
            error={kindSummary.error}
            rows={kindSummary.data ?? []}
            emptyTitle="No catalog or schema grants"
            emptyDescription="No privileges matched this catalog pattern."
            searchLabel="Filter grant classes"
            searchPlaceholder="Principal type or class"
            getSearchText={(row) => `${row.grantee_kind} ${row.privilege_class}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Principal type</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Grants</TableHead>
                    <TableHead>Principals</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.grantee_kind}-${row.privilege_class}`}>
                      <TableCell>{formatGranteeKind(row.grantee_kind)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{row.privilege_class}</Badge>
                      </TableCell>
                      <TableCell>{formatNumber(row.grant_count)}</TableCell>
                      <TableCell>{formatNumber(row.principal_count)}</TableCell>
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
          <CardTitle>Top principals by grants</CardTitle>
          <CardDescription>
            Who holds the most catalog and schema privileges. Use Principal type to isolate users versus groups versus
            service principals, then search a name below to open their grant set.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={topPrincipals.loading}
            error={topPrincipals.error}
            rows={topPrincipals.data ?? []}
            emptyTitle="No principals"
            emptyDescription="No grantees matched this catalog pattern and principal type."
            searchLabel="Filter principals"
            searchPlaceholder="User, group, or service principal"
            getSearchText={(row) => `${row.grantee} ${row.grantee_kind} ${row.privileges}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Principal</TableHead>
                    <TableHead>Grants</TableHead>
                    <TableHead>Catalogs</TableHead>
                    <TableHead>Privileges</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.grantee_kind}-${row.grantee}`}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left text-primary underline-offset-4 hover:underline"
                          onClick={() => {
                            setGranteeInput(row.grantee);
                            setGranteeFilter(row.grantee);
                            setGranteeKind(row.grantee_kind);
                          }}
                        >
                          {row.grantee}
                        </button>
                        <div className="text-xs text-muted-foreground">{formatGranteeKind(row.grantee_kind)}</div>
                      </TableCell>
                      <TableCell>{formatNumber(row.grant_count)}</TableCell>
                      <TableCell>{formatNumber(row.catalog_count)}</TableCell>
                      <TableCell>
                        <PrivilegeSet privileges={parsePrivilegeList(row.privileges)} />
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
        <CardTitle>Effective privileges</CardTitle>
        <CardDescription>
          Grants grouped by class, with privileges collected into a compact set. Filter by principal type to see only
          users, groups, or service principals. Table, function, and volume grants load only when a catalog is selected
          or the catalog pattern is narrowed off estate-wide `%`.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-2">
            <Label htmlFor="resource-catalog">Resource catalog</Label>
            <Select
              value={catalogName}
              onValueChange={(value) => {
                setCatalogName(value);
                setSchemaName(ALL);
                setTableName(ALL);
              }}
            >
              <SelectTrigger id="resource-catalog">
                <SelectValue placeholder="All catalogs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All matching catalogs</SelectItem>
                {(catalogs.data ?? []).map((row) => (
                  <SelectItem key={row.catalog_name} value={row.catalog_name}>
                    {row.catalog_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="resource-schema">Resource schema</Label>
            <Select
              value={schemaName}
              onValueChange={(value) => {
                setSchemaName(value);
                setTableName(ALL);
              }}
              disabled={!selectedCatalog}
            >
              <SelectTrigger id="resource-schema">
                <SelectValue placeholder={selectedCatalog ? 'All schemas' : 'Select a catalog first'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All schemas</SelectItem>
                {(schemas.data ?? []).map((row) => (
                  <SelectItem key={row.schema_name} value={row.schema_name}>
                    {row.schema_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="resource-table">Resource table</Label>
            <Select value={tableName} onValueChange={setTableName} disabled={!selectedSchema}>
              <SelectTrigger id="resource-table">
                <SelectValue placeholder={selectedSchema ? 'All tables' : 'Select a schema first'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All tables</SelectItem>
                {(tables.data ?? []).map((row) => (
                  <SelectItem key={row.table_name} value={row.table_name}>
                    {row.table_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="principal-type">Principal type</Label>
            <Select value={granteeKind} onValueChange={setGranteeKind}>
              <SelectTrigger id="principal-type">
                <SelectValue placeholder="All principal types" />
              </SelectTrigger>
              <SelectContent>
                {GRANTEE_KIND_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="privilege-grantee">Grantee</Label>
            <Input
              id="privilege-grantee"
              value={granteeInput}
              onChange={(event) => setGranteeInput(event.target.value)}
              placeholder="user, group, or email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="privilege-class">Class</Label>
            <Select value={privilegeClass} onValueChange={setPrivilegeClass}>
              <SelectTrigger id="privilege-class">
                <SelectValue placeholder="All classes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All classes</SelectItem>
                {PRIVILEGE_CLASS_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!includeObjects ? (
          <p className="text-sm text-muted-foreground">
            Showing catalog and schema grants. Select a catalog, or set the catalog pattern to a
            specific catalog (for example <code>demos</code>), to load object-level grants.
          </p>
        ) : null}
        <FilteredTable
          loading={privileges.loading || (includeObjects && objectPrivileges.loading)}
          error={privileges.error || (includeObjects ? objectPrivileges.error : null)}
          rows={rows}
          emptyTitle="No matching grants"
          emptyDescription="Try a broader catalog, grantee, or class filter."
          searchLabel="Filter grants"
          searchPlaceholder="Resource, grantee, or privilege"
          getSearchText={(row) =>
            `${row.privilege_class} ${row.privileges} ${row.resource_name} ${row.grantee} ${row.grantee_kind}`
          }
        >
          {(pageRows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Class</TableHead>
                  <TableHead>Privileges</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Grantee</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row, index) => {
                  const showGroup = index === 0 || pageRows[index - 1].privilege_class !== row.privilege_class;
                  return (
                    <Fragment key={`${row.resource_name}-${row.grantee}-${row.privilege_class}`}>
                      {showGroup ? (
                        <TableRow>
                          <TableCell colSpan={4} className="bg-muted/40 text-sm font-medium">
                            {row.privilege_class}
                          </TableCell>
                        </TableRow>
                      ) : null}
                      <TableRow>
                        <TableCell>
                          <Badge variant="secondary">{row.privilege_class}</Badge>
                        </TableCell>
                        <TableCell>
                          <PrivilegeSet privileges={parsePrivilegeList(row.privileges)} />
                        </TableCell>
                        <TableCell>{row.resource_name}</TableCell>
                        <TableCell>
                          <div>{row.grantee}</div>
                          <div className="text-xs text-muted-foreground">{formatGranteeKind(row.grantee_kind)}</div>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </FilteredTable>
      </CardContent>
    </Card>
    </div>
  );
}

function PrivilegeSet({ privileges }: { privileges: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const extra = privileges.length - PREVIEW_PRIVILEGES;
  const shown = expanded || extra <= 0 ? privileges : privileges.slice(0, PREVIEW_PRIVILEGES);

  if (privileges.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((privilege) => (
        <Badge key={privilege} variant="outline">
          {privilege}
        </Badge>
      ))}
      {extra > 0 ? (
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : `+${extra} more`}
        </Button>
      ) : null}
    </div>
  );
}

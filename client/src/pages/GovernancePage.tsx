import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { sql } from '@databricks/appkit-ui/js';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
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
import { ConfirmActionDialog } from '@/components/ConfirmActionDialog';
import { FilterBar } from '@/components/FilterBar';
import { FilteredTable } from '@/components/FilteredTable';
import { GovernanceTagsPanel } from '@/components/GovernanceTagsPanel';
import { LineageExplorer } from '@/components/LineageExplorer';
import { ObjectExplorer } from '@/components/ObjectExplorer';
import { PrivilegeInventory } from '@/components/PrivilegeInventory';
import { adminApi, useApi } from '@/lib/admin-api';
import { formatNumber } from '@/lib/formatters';
import type { AdminOutletContext } from '@/lib/outlet';
import type { MutationPreview } from '../../../shared/admin-insights';

export function GovernancePage() {
  const { filters, setFilters, identity } = useOutletContext<AdminOutletContext>();
  const host = identity?.runtime.workspaceHost ?? null;
  const catalogParams = useMemo(
    () => ({ catalogPattern: sql.string(filters.catalogPattern || '%') }),
    [filters.catalogPattern],
  );
  const rangeParams = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
      limit: sql.number(50),
    }),
    [filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const accessParams = useMemo(
    () => ({
      ...rangeParams,
      actionFilter: sql.string(''),
    }),
    [rangeParams],
  );

  const comments = useAnalyticsQuery('comment_coverage', catalogParams);
  const storage = useAnalyticsQuery('storage_metrics', {
    startDate: sql.date(filters.startDate),
    endDate: sql.date(filters.endDate),
    catalogPattern: sql.string(filters.catalogPattern || '%'),
    limit: sql.number(50),
  });
  const accessEvents = useAnalyticsQuery('native_access_activity', accessParams);
  const schemaCreation = useAnalyticsQuery('schema_creation_activity', rangeParams);
  const objectAccess = useAnalyticsQuery('object_access_activity', rangeParams);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Data governance and object explorer</h2>
        <p className="text-sm text-muted-foreground">
          Unity Catalog objects, privileges by user versus group versus service principal, governed tags, lineage, and
          native access requests. Data classification and data quality tiles stay on Overview readiness until those
          system tables are granted.
        </p>
      </div>
      <FilterBar filters={filters} onChange={setFilters} />
      <Card>
        <CardHeader>
          <CardTitle>Storage collection status</CardTitle>
          <CardDescription>
            Active bytes come only from system.storage.table_metrics_history. Empty means not collected, not zero.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={storage.loading}
            error={storage.error}
            rows={storage.data ?? []}
            emptyTitle="Storage metrics not collected"
            emptyDescription="system.storage.table_metrics_history currently has no rows for this range. The app will not estimate size."
            searchLabel="Filter storage snapshots"
            searchPlaceholder="Catalog or snapshot date"
            getSearchText={(row) => `${row.catalog_name} ${row.snapshot_date}`}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Catalog</TableHead>
                    <TableHead>Tables</TableHead>
                    <TableHead>Active bytes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.snapshot_date}-${row.catalog_name}`}>
                      <TableCell>{String(row.snapshot_date)}</TableCell>
                      <TableCell>{row.catalog_name}</TableCell>
                      <TableCell>{formatNumber(row.table_count)}</TableCell>
                      <TableCell>{formatNumber(row.active_bytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        </CardContent>
      </Card>
      <Tabs defaultValue="objects">
        <TabsList>
          <TabsTrigger value="objects">Objects</TabsTrigger>
          <TabsTrigger value="privileges">Privileges</TabsTrigger>
          <TabsTrigger value="tags">Tags</TabsTrigger>
          <TabsTrigger value="activity">Observed activity</TabsTrigger>
          <TabsTrigger value="requests">Access requests</TabsTrigger>
        </TabsList>
        <TabsContent value="objects" className="space-y-4">
          <ObjectExplorer catalogPattern={filters.catalogPattern} host={host} />
          <Card>
            <CardHeader>
              <CardTitle>Comment coverage</CardTitle>
            </CardHeader>
            <CardContent>
              <FilteredTable
                loading={comments.loading}
                error={comments.error}
                rows={comments.data ?? []}
                emptyTitle="No table metadata"
                emptyDescription="No tables matched the catalog filter."
                searchLabel="Filter comment coverage"
                searchPlaceholder="Catalog"
                getSearchText={(row) => row.catalog_name}
              >
                {(pageRows) => (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Catalog</TableHead>
                        <TableHead>Tables</TableHead>
                        <TableHead>Commented</TableHead>
                        <TableHead>Missing comments</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.map((row) => (
                        <TableRow key={row.catalog_name}>
                          <TableCell>{row.catalog_name}</TableCell>
                          <TableCell>{formatNumber(row.table_count)}</TableCell>
                          <TableCell>{formatNumber(row.commented_tables)}</TableCell>
                          <TableCell>{formatNumber(row.uncommented_tables)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </FilteredTable>
            </CardContent>
          </Card>
          <LineageExplorer
            startDate={filters.startDate}
            endDate={filters.endDate}
            workspaceScope={filters.workspaceScope}
            catalogPattern={filters.catalogPattern}
            host={host}
          />
        </TabsContent>
        <TabsContent value="privileges" className="space-y-4">
          <PrivilegeInventory catalogPattern={filters.catalogPattern} />
        </TabsContent>
        <TabsContent value="tags" className="space-y-4">
          <GovernanceTagsPanel filters={filters} host={host} />
        </TabsContent>
        <TabsContent value="activity" className="space-y-4">
          <ActivityTable
            title="Native access requests"
            loading={accessEvents.loading}
            error={accessEvents.error}
            rows={(accessEvents.data ?? []).map((row) => [
              String(row.activity_date),
              row.requester,
              row.securable_name ?? '—',
              row.privilege ?? row.action_name,
            ])}
            emptyTitle="No native access-request events"
            emptyDescription="The 90-day MV has no request-for-access facts in this range."
          />
          <ActivityTable
            title="Schema and object creation"
            loading={schemaCreation.loading}
            error={schemaCreation.error}
            rows={(schemaCreation.data ?? []).map((row) => [
              String(row.activity_date),
              row.actor,
              row.action_name,
              row.securable_name ?? '—',
            ])}
            emptyTitle="No schema-creation events"
            emptyDescription="The 90-day MV has no createSchema/createTable facts in this range."
          />
          <ActivityTable
            title="Observed object access"
            loading={objectAccess.loading}
            error={objectAccess.error}
            rows={(objectAccess.data ?? []).map((row) => [
              String(row.activity_date),
              row.actor,
              row.action_name,
              String(row.event_count),
            ])}
            emptyTitle="No object-access events"
            emptyDescription="The 90-day MV has no object-access facts in this range."
          />
        </TabsContent>
        <TabsContent value="requests">
          <AccessRequestPanel canWrite={Boolean(identity?.actor.isRequester)} isAdmin={Boolean(identity?.actor.isAdmin)} />
        </TabsContent>
      </Tabs>
      {identity?.actor.isAdmin ? <TagActionPanel /> : null}
    </div>
  );
}

function ActivityTable({
  title,
  loading,
  error,
  rows,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  rows: string[][];
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <FilteredTable
          loading={loading}
          error={error}
          rows={rows}
          emptyTitle={emptyTitle}
          emptyDescription={emptyDescription}
          searchLabel="Filter activity"
          searchPlaceholder="Date, actor, or detail"
          getSearchText={(row) => row.join(' ')}
        >
          {(pageRows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => (
                  <TableRow key={row.join('|')}>
                    {row.map((cell) => (
                      <TableCell key={cell}>{cell}</TableCell>
                    ))}
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

function AccessRequestPanel({ canWrite, isAdmin }: { canWrite: boolean; isAdmin: boolean }) {
  const { data, error, loading, refresh } = useApi<Awaited<ReturnType<typeof adminApi.listRequests>>>('/requests');
  const [resourceName, setResourceName] = useState('demos.admin_insights');
  const [justification, setJustification] = useState('Need SELECT for an investigation');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lakebase access requests</CardTitle>
        <CardDescription>Record and progress access requests. This app does not grant or revoke data access.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite ? (
          <form
            className="grid gap-3 md:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              void adminApi
                .submitRequest({
                  subjectPrincipalType: 'user',
                  resourceType: 'schema',
                  resourceName,
                  requestedPrivileges: ['SELECT'],
                  justification,
                  requestMode: 'self',
                  idempotencyKey: `req-${Date.now()}`,
                })
                .then(() => refresh());
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="resource-name">Resource name</Label>
              <Input id="resource-name" value={resourceName} onChange={(event) => setResourceName(event.target.value)} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="justification">Justification</Label>
              <Input id="justification" value={justification} onChange={(event) => setJustification(event.target.value)} />
            </div>
            <Button type="submit">New access request</Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Requester role required</p>
        )}
        <FilteredTable
          loading={loading}
          error={error}
          rows={data ?? []}
          emptyTitle="No access requests"
          emptyDescription="Submit a request to track remediation in Lakebase."
          searchLabel="Filter requests"
          searchPlaceholder="Resource, requester, or status"
          getSearchText={(row) => `${row.resourceName} ${row.requestedBy} ${row.status}`}
        >
          {(pageRows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.resourceName}</TableCell>
                    <TableCell>{row.requestedBy}</TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell>
                      {isAdmin && row.status === 'submitted' ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => void adminApi.approve(row.id, 'Approved in Admin Insights').then(() => refresh())}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void adminApi.deny(row.id, 'Denied in Admin Insights').then(() => refresh())}
                          >
                            Deny
                          </Button>
                        </div>
                      ) : (
                        '—'
                      )}
                    </TableCell>
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

function TagActionPanel() {
  const [entityName, setEntityName] = useState('demos.admin_insights');
  const [tagKey, setTagKey] = useState('team');
  const [tagValue, setTagValue] = useState('platform');
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tag a Unity Catalog object</CardTitle>
        <CardDescription>Preview, confirm, then apply with the signed-in user’s APPLY TAG privilege.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="uc-entity">Schema or table name</Label>
            <Input id="uc-entity" value={entityName} onChange={(event) => setEntityName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="uc-tag-key">Tag key</Label>
            <Input id="uc-tag-key" value={tagKey} onChange={(event) => setTagKey(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="uc-tag-value">Tag value</Label>
            <Input id="uc-tag-value" value={tagValue} onChange={(event) => setTagValue(event.target.value)} />
          </div>
        </div>
        <Button
          onClick={() => {
            void adminApi
              .previewUcTag({ entityType: 'schemas', entityName, tagKey, tagValue })
              .then((result) => {
                setPreview(result);
                setOpen(true);
              })
              .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Preview failed'));
          }}
        >
          Preview tag update
        </Button>
        {message ? <p className="text-sm text-destructive">{message}</p> : null}
        <ConfirmActionDialog
          open={open}
          onOpenChange={setOpen}
          preview={preview}
          pending={pending}
          onConfirm={() => {
            setPending(true);
            void adminApi
              .applyUcTag({ entityType: 'schemas', entityName, tagKey, tagValue, confirmed: true })
              .then((result) => {
                setMessage(result.error ?? (result.applied ? 'Tag applied' : 'Dry run recorded'));
                setOpen(false);
              })
              .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Apply failed'))
              .finally(() => setPending(false));
          }}
        />
      </CardContent>
    </Card>
  );
}

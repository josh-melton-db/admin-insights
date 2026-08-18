import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { sql } from '@databricks/appkit-ui/js';
import {
  Alert,
  AlertDescription,
  AlertTitle,
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
import { ConfirmActionDialog } from '@/components/ConfirmActionDialog';
import { FilterBar } from '@/components/FilterBar';
import { FilteredTable } from '@/components/FilteredTable';
import { UntaggedJobsPanel } from '@/components/UntaggedJobsPanel';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { adminApi, useApi } from '@/lib/admin-api';
import { formatCurrency, formatNumber } from '@/lib/formatters';
import { ALL_FILTER, COMPACT_LIST_FETCH_LIMIT, LIST_FETCH_LIMIT, matchesPaused, PAUSED_FILTER_OPTIONS, scaleToZeroLabel, scaleToZeroListFilter } from '@/lib/list-controls';
import type { AdminOutletContext } from '@/lib/outlet';
import {
  appDetailsUrl,
  jobUrl,
  pipelineUrl,
  servingEndpointUrl,
  tableUrlFromFullName,
  vectorSearchUrl,
} from '@/lib/workspace-links';
import type { InventoryItem, MutationPreview, UsagePolicy } from '../../../shared/admin-insights';

export function HygienePage() {
  const { filters, setFilters, identity } = useOutletContext<AdminOutletContext>();
  const host = identity?.runtime.workspaceHost ?? null;
  const rangeParams = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
      limit: sql.number(LIST_FETCH_LIMIT),
    }),
    [filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const lineageLimited = useMemo(
    () => ({
      startDate: sql.date(filters.startDate),
      endDate: sql.date(filters.endDate),
      workspaceScope: sql.string(filters.workspaceScope),
      catalogPattern: sql.string(filters.catalogPattern || '%'),
      limit: sql.number(COMPACT_LIST_FETCH_LIMIT),
    }),
    [filters.catalogPattern, filters.endDate, filters.startDate, filters.workspaceScope],
  );
  const idleJobs = useAnalyticsQuery('hygiene_idle_jobs', {
    ...rangeParams,
    nameFilter: sql.string(''),
    creatorFilter: sql.string(''),
    pausedFilter: sql.string(ALL_FILTER),
  });
  const unusedTables = useAnalyticsQuery('roi_unused_produced_tables', lineageLimited);
  const idleServing = useAnalyticsQuery('roi_idle_serving', rangeParams);
  const idleVector = useAnalyticsQuery('roi_idle_vector_search', rangeParams);
  const appUsage = useAnalyticsQuery('hygiene_app_usage', rangeParams);
  const endpointUsage = useAnalyticsQuery('hygiene_endpoint_usage', rangeParams);
  const jobs = useApi<InventoryItem[]>(identity?.actor.isAdmin ? '/inventory/jobs' : null);
  const apps = useApi<InventoryItem[]>(identity?.actor.isAdmin ? '/inventory/apps' : null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Resource hygiene</h2>
        <p className="text-sm text-muted-foreground">
          Low-ROI resources: unused jobs, unread produced tables, serving with no queries, Vector Search without
          indexes (not Agent Bricks ka- / mas- endpoints), and apps with no user-authorization actions. Click an untagged job to see its owner, their groups,
          and create a serverless usage policy for a group. Safe actions: tags and existing usage policies.
        </p>
      </div>
      <FilterBar filters={filters} onChange={setFilters} />
      <UntaggedJobsPanel
        workspaceScope={filters.workspaceScope}
        host={host}
        isAdmin={Boolean(identity?.actor.isAdmin)}
      />
      <Card>
        <CardHeader>
          <CardTitle>Jobs with no run in range</CardTitle>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={idleJobs.loading}
            error={idleJobs.error}
            rows={idleJobs.data ?? []}
            emptyTitle="No idle jobs"
            emptyDescription="Every visible job ran in this window."
            searchLabel="Filter idle jobs"
            searchPlaceholder="Job name or creator"
            getSearchText={(row) => `${row.name} ${row.creator_user_name} ${row.job_id}`}
            filters={[
              {
                id: 'paused',
                label: 'Paused',
                options: PAUSED_FILTER_OPTIONS,
                match: (row, value) => matchesPaused(row.paused, value),
              },
            ]}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Paused</TableHead>
                    <TableHead>Creator</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.job_id}`}>
                      <TableCell>
                        <WorkspaceLink href={jobUrl(host, row.job_id)}>{row.name}</WorkspaceLink>
                      </TableCell>
                      <TableCell>{row.paused ? 'Paused' : 'Not paused'}</TableCell>
                      <TableCell>{row.creator_user_name}</TableCell>
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
          <CardTitle>Tables produced with no reads</CardTitle>
          <CardDescription>Job and pipeline outputs that were never read as a lineage source in this window</CardDescription>
        </CardHeader>
        <CardContent>
          <FilteredTable
            loading={unusedTables.loading}
            error={unusedTables.error}
            rows={unusedTables.data ?? []}
            emptyTitle="No unread produced tables"
            emptyDescription="Every table written in this window was also read, or no write lineage was recorded."
            searchLabel="Filter unused tables"
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
                        <WorkspaceLink
                          href={
                            row.producer_type === 'JOB'
                              ? jobUrl(host, row.producer_id)
                              : row.producer_type === 'PIPELINE'
                                ? pipelineUrl(host, row.producer_id)
                                : null
                          }
                        >
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
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Serving endpoints with no queries</CardTitle>
            <CardDescription>
              Always-on endpoints with no queries keep billed replicas. Filter by whether the endpoint scales to zero.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={idleServing.loading}
              error={idleServing.error}
              rows={idleServing.data ?? []}
              emptyTitle="No idle serving endpoints"
              emptyDescription="Every billed serving endpoint received at least one request."
              searchLabel="Filter serving endpoints"
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
              VECTOR_SEARCH spend with no index_id. Agent Bricks ka- and mas- endpoints are excluded.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={idleVector.loading}
              error={idleVector.error}
              rows={idleVector.data ?? []}
              emptyTitle="No index-less Vector Search spend"
              emptyDescription="No VECTOR_SEARCH billing rows lacked an index_id after excluding Agent Bricks endpoints."
              searchLabel="Filter Vector Search endpoints"
              searchPlaceholder="Endpoint name"
              getSearchText={(row) => row.endpoint_name}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
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
            <CardTitle>App usage (user authorization)</CardTitle>
            <CardDescription>
              Least recently billed first. Usage is OBO user-authorization actions, not compute on/off. Open Insights
              on the app details page. Apps without user API scopes may run only as the app service principal.
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
                  id: 'scopes',
                  label: 'Scopes',
                  options: [
                    { value: ALL_FILTER, label: 'All scopes' },
                    { value: 'has_user_api_scopes', label: 'Has user API scopes' },
                    { value: 'no_user_api_scopes', label: 'No user API scopes' },
                    { value: 'unknown', label: 'Scopes unknown' },
                  ],
                  match: (row, value) => value === ALL_FILTER || row.scope_band === value,
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
                          {formatNumber(row.user_obo_events)} · {formatNumber(row.user_obo_users)} users
                          <div className="text-xs text-muted-foreground">
                            {row.last_obo_date ? String(row.last_obo_date) : 'No OBO in range'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.scope_band === 'has_user_api_scopes' ? 'secondary' : 'outline'}>
                            {row.usage_band === 'app_sp_only_suspected'
                              ? 'App SP only (suspected)'
                              : row.scope_band === 'no_user_api_scopes'
                                ? 'No user API scopes'
                                : row.scope_band === 'has_user_api_scopes'
                                  ? 'Has user API scopes'
                                  : 'Scopes unknown'}
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
            <CardTitle>Serving billing evidence</CardTitle>
            <CardDescription>
              Least recently used first. Databricks-hosted foundation models (databricks-%) are excluded. Filter by
              whether the endpoint scales to zero. Query counts come from serving.endpoint_usage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilteredTable
              loading={endpointUsage.loading}
              error={endpointUsage.error}
              rows={endpointUsage.data ?? []}
              emptyTitle="No endpoint usage"
              emptyDescription="No billing rows with a non-databricks-% endpoint_name in this range."
              searchLabel="Filter billed endpoints"
              searchPlaceholder="Endpoint name"
              getSearchText={(row) => `${row.endpoint_name} ${scaleToZeroLabel(row.scale_to_zero_band)}`}
              filters={[scaleToZeroListFilter('Billed serving scale to zero')]}
            >
              {(pageRows) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Scale</TableHead>
                      <TableHead>Queries</TableHead>
                      <TableHead>Last usage</TableHead>
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
                        <TableCell>{formatNumber(row.query_count)}</TableCell>
                        <TableCell>{String(row.last_usage_date)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </FilteredTable>
          </CardContent>
        </Card>
      </div>
      {identity?.actor.isAdmin ? (
        <SafeActionPanel
          jobs={jobs.data ?? []}
          apps={apps.data ?? []}
          jobsError={jobs.error}
          appsError={apps.error}
        />
      ) : (
        <Alert>
          <AlertTitle>Administrator role required</AlertTitle>
          <AlertDescription>Tag and policy mutations are limited to administrators.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function SafeActionPanel({
  jobs,
  apps,
  jobsError,
  appsError,
}: {
  jobs: InventoryItem[];
  apps: InventoryItem[];
  jobsError: string | null;
  appsError: string | null;
}) {
  const policies = useApi<UsagePolicy[]>('/policies');
  const [jobId, setJobId] = useState(jobs[0]?.id ?? '');
  const [appName, setAppName] = useState(apps[0]?.id ?? '');
  const [tagKey, setTagKey] = useState('owner');
  const [tagValue, setTagValue] = useState('platform');
  const [policyId, setPolicyId] = useState('');
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [apply, setApply] = useState<(() => Promise<void>) | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const openPreview = (next: Promise<MutationPreview>, confirm: () => Promise<unknown>) => {
    void next
      .then((result) => {
        setPreview(result);
        setApply(() => async () => {
          await confirm();
        });
        setOpen(true);
      })
      .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Preview failed'));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Safe actions</CardTitle>
        <CardDescription>
          Assign an existing serverless usage policy or add job tags. Policies are never created here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>Jobs and Apps APIs are outside this app OBO scopes</AlertTitle>
          <AlertDescription>
            This app’s user scopes are <code>sql</code>, <code>serving.serving-endpoints</code>, and{' '}
            <code>catalog.catalogs</code>. Job tag/policy and Apps inventory calls need Jobs or Apps OAuth
            scopes, which Databricks Apps does not accept in this workspace. Untagged and idle lists still
            come from system tables. Unity Catalog tags use SQL instead of the Unity Catalog REST API.
            {jobsError || appsError ? ` ${[jobsError, appsError].filter(Boolean).join(' ')}` : ''}
          </AlertDescription>
        </Alert>
        <div className="grid gap-3 md:grid-cols-2">
          <ResourcePicker
            id="job-id"
            label="Job ID"
            value={jobId}
            onChange={setJobId}
            items={jobs}
            placeholder="Filter or paste a job ID"
          />
          <div className="space-y-2">
            <Label htmlFor="job-tag">Job tag</Label>
            <div className="flex gap-2">
              <Input aria-label="Job tag key" value={tagKey} onChange={(event) => setTagKey(event.target.value)} />
              <Input aria-label="Job tag value" value={tagValue} onChange={(event) => setTagValue(event.target.value)} />
            </div>
          </div>
        </div>
        <Button
          onClick={() =>
            openPreview(
              adminApi.previewJobTags({ jobId: Number(jobId), tags: { [tagKey]: tagValue } }),
              () => adminApi.applyJobTags({ jobId: Number(jobId), tags: { [tagKey]: tagValue }, confirmed: true }),
            )
          }
        >
          Preview job tag update
        </Button>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="policy-id">Existing usage policy</Label>
            {policies.data?.length ? (
              <Select value={policyId} onValueChange={setPolicyId}>
                <SelectTrigger id="policy-id">
                  <SelectValue placeholder="Select a policy" />
                </SelectTrigger>
                <SelectContent>
                  {policies.data.map((policy) => (
                    <SelectItem key={policy.policyId} value={policy.policyId}>
                      {policy.policyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="policy-id"
                value={policyId}
                onChange={(event) => setPolicyId(event.target.value)}
                placeholder="Paste an existing policy ID"
              />
            )}
          </div>
          <ResourcePicker
            id="app-name"
            label="App name"
            value={appName}
            onChange={setAppName}
            items={apps}
            placeholder="Filter or paste an app name"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              openPreview(
                adminApi.previewJobPolicy({ jobId: Number(jobId), policyId }),
                () => adminApi.applyJobPolicy({ jobId: Number(jobId), policyId, confirmed: true }),
              )
            }
          >
            Preview job policy assignment
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              openPreview(
                adminApi.previewAppPolicy({ appName, policyId }),
                () => adminApi.applyAppPolicy({ appName, policyId, confirmed: true }),
              )
            }
          >
            Preview app policy assignment
          </Button>
        </div>
        {policies.error ? (
          <p className="text-sm text-muted-foreground">
            Policy picker unavailable without DATABRICKS_ACCOUNT_HOST and DATABRICKS_ACCOUNT_ID. Paste a known policy ID
            instead. {policies.error}
          </p>
        ) : null}
        {message ? <p className="text-sm text-destructive">{message}</p> : null}
        <ConfirmActionDialog
          open={open}
          onOpenChange={setOpen}
          preview={preview}
          pending={pending}
          onConfirm={() => {
            if (!apply) {
              return;
            }
            setPending(true);
            void apply()
              .then(() => {
                setMessage('Action recorded');
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

function ResourcePicker({
  id,
  label,
  value,
  onChange,
  items,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: InventoryItem[];
  placeholder?: string;
}) {
  const query = value.trim().toLowerCase();
  const options = items
    .filter(
      (item) =>
        !query || item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query),
    )
    .slice(0, 50);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        list={`${id}-options`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <datalist id={`${id}-options`}>
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </datalist>
    </div>
  );
}

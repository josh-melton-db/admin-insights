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
import { UntaggedJobPolicyDialog } from '@/components/UntaggedJobPolicyDialog';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { formatNumber } from '@/lib/formatters';
import { ALL_FILTER, LIST_FETCH_LIMIT, matchesPaused, PAUSED_FILTER_OPTIONS } from '@/lib/list-controls';
import { jobUrl } from '@/lib/workspace-links';

export function UntaggedJobsPanel({
  workspaceScope,
  host,
  isAdmin,
}: {
  workspaceScope: 'current' | 'all';
  host: string | null;
  isAdmin: boolean;
}) {
  const [selectedCreator, setSelectedCreator] = useState<{
    workspace_id: string;
    creator_user_name: string;
  } | null>(null);
  const [selectedJob, setSelectedJob] = useState<{
    workspace_id: string;
    job_id: string;
    name: string;
    creator_user_name: string;
  } | null>(null);

  const creators = useAnalyticsQuery('hygiene_untagged_job_creators', {
    workspaceScope: sql.string(workspaceScope),
    creatorFilter: sql.string(''),
    limit: sql.number(LIST_FETCH_LIMIT),
  });
  const jobs = useAnalyticsQuery(
    'hygiene_untagged_jobs',
    {
      workspaceScope: sql.string(workspaceScope),
      nameFilter: sql.string(''),
      creatorFilter: sql.string(selectedCreator?.creator_user_name ?? ''),
      pausedFilter: sql.string(ALL_FILTER),
      limit: sql.number(LIST_FETCH_LIMIT),
    },
    { autoStart: Boolean(selectedCreator) },
  );

  const jobRows = jobs.data ?? [];
  const relatedJobs = useMemo(
    () =>
      selectedJob
        ? jobRows.filter((row) => row.creator_user_name === selectedJob.creator_user_name)
        : [],
    [jobRows, selectedJob],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Untagged jobs</CardTitle>
        <CardDescription>
          Jobs whose tags map is empty, grouped by creator. Open a creator to filter that owner’s jobs, then click a
          job to inspect groups and create a serverless usage policy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              {selectedCreator ? (
                <BreadcrumbLink asChild>
                  <button type="button" onClick={() => setSelectedCreator(null)}>
                    Creators
                  </button>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>Creators</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {selectedCreator ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{selectedCreator.creator_user_name}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        {selectedCreator ? (
          <FilteredTable
            loading={jobs.loading}
            error={jobs.error}
            rows={jobRows}
            emptyTitle="No untagged jobs for this creator"
            emptyDescription="This owner has no visible untagged jobs in the current workspace scope."
            searchLabel="Filter jobs"
            searchPlaceholder="Job name"
            getSearchText={(row) => `${row.name} ${row.job_id}`}
            filters={[
              {
                id: 'paused',
                label: 'Job paused',
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
                    <TableHead>Last run</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.job_id}`}>
                      <TableCell>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-left"
                          onClick={() =>
                            setSelectedJob({
                              workspace_id: row.workspace_id,
                              job_id: String(row.job_id),
                              name: row.name,
                              creator_user_name: row.creator_user_name,
                            })
                          }
                        >
                          {row.name}
                        </Button>
                        <div className="text-xs">
                          <WorkspaceLink href={jobUrl(host, row.job_id)}>Open job</WorkspaceLink>
                        </div>
                      </TableCell>
                      <TableCell>{row.paused ? 'Paused' : 'Not paused'}</TableCell>
                      <TableCell>{row.last_run_time ? String(row.last_run_time) : 'Never'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        ) : (
          <FilteredTable
            loading={creators.loading}
            error={creators.error}
            rows={creators.data ?? []}
            emptyTitle="No untagged jobs"
            emptyDescription="Every visible job already has at least one tag."
            searchLabel="Filter creators"
            searchPlaceholder="Creator email or name"
            getSearchText={(row) => row.creator_user_name}
          >
            {(pageRows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Creator</TableHead>
                    <TableHead>Untagged jobs</TableHead>
                    <TableHead>Paused</TableHead>
                    <TableHead>Last run</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={`${row.workspace_id}-${row.creator_user_name}`}>
                      <TableCell>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-left"
                          onClick={() =>
                            setSelectedCreator({
                              workspace_id: row.workspace_id,
                              creator_user_name: row.creator_user_name,
                            })
                          }
                        >
                          {row.creator_user_name}
                        </Button>
                      </TableCell>
                      <TableCell>{formatNumber(row.job_count)}</TableCell>
                      <TableCell>{formatNumber(row.paused_job_count)}</TableCell>
                      <TableCell>{row.last_run_time ? String(row.last_run_time) : 'Never'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredTable>
        )}
      </CardContent>
      <UntaggedJobPolicyDialog
        job={selectedJob}
        relatedJobs={relatedJobs}
        isAdmin={isAdmin}
        onClose={() => setSelectedJob(null)}
      />
    </Card>
  );
}

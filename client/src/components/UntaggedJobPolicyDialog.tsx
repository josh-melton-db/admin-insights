import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
} from '@databricks/appkit-ui/react';
import { ConfirmActionDialog } from '@/components/ConfirmActionDialog';
import { QueryPanel } from '@/components/QueryPanel';
import { adminApi } from '@/lib/admin-api';
import type { IdentityGroup, JobOwnerIdentity, MutationPreview } from '../../../shared/admin-insights';

export interface UntaggedJobRow {
  workspace_id: string;
  job_id: string;
  name: string;
  creator_user_name: string;
}

function defaultPolicyName(groupDisplayName: string): string {
  const slug = groupDisplayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug ? `serverless-${slug}` : 'serverless-usage-policy';
}

function groupKindLabel(kind: IdentityGroup['kind']): string {
  if (kind === 'account') return 'Account group';
  if (kind === 'workspace') return 'Workspace-local — cannot receive this policy';
  return 'Group kind unknown';
}

export function UntaggedJobPolicyDialog({
  job,
  relatedJobs,
  isAdmin,
  onClose,
}: {
  job: UntaggedJobRow | null;
  relatedJobs: UntaggedJobRow[];
  isAdmin: boolean;
  onClose: () => void;
}) {
  const open = Boolean(job);
  const ownerName = job?.creator_user_name?.trim() ?? '';
  const [identity, setIdentity] = useState<JobOwnerIdentity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [policyName, setPolicyName] = useState('');
  const [tagKey, setTagKey] = useState('team');
  const [tagValue, setTagValue] = useState('');
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !ownerName || !isAdmin) {
      setIdentity(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIdentity(null);
    void adminApi
      .listJobOwnerIdentity(ownerName)
      .then((result) => {
        if (cancelled) return;
        setIdentity(result);
        const firstUsable = result.groups.find((group) => group.kind !== 'workspace');
        setGroupId(firstUsable?.id ?? '');
        if (firstUsable) {
          setPolicyName(defaultPolicyName(firstUsable.displayName));
          setTagValue(firstUsable.displayName);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Unable to load owner groups');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, open, ownerName]);

  const selectedGroup = useMemo(
    () => identity?.groups.find((group) => group.id === groupId) ?? null,
    [groupId, identity?.groups],
  );

  const selectGroup = (nextId: string) => {
    setGroupId(nextId);
    const next = identity?.groups.find((group) => group.id === nextId);
    if (next) {
      setPolicyName(defaultPolicyName(next.displayName));
      setTagValue(next.displayName);
    }
  };

  const payload = job
    ? {
        jobId: String(job.job_id),
        jobName: job.name,
        ownerUserName: ownerName,
        groupId,
        groupDisplayName: selectedGroup?.displayName ?? '',
        groupKind: selectedGroup?.kind ?? 'unknown',
        policyName,
        customTags: { [tagKey]: tagValue },
      }
    : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton>
          <DialogHeader>
            <DialogTitle>Owner groups and serverless usage policy</DialogTitle>
            <DialogDescription>
              Review who owns this untagged job, the groups that identity belongs to, then create a serverless usage
              policy and grant it to a group. Existing jobs are not auto-assigned.
            </DialogDescription>
          </DialogHeader>
          {job ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-foreground">{job.name}</p>
                <p className="text-sm text-muted-foreground">Job ID {job.job_id}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Owners of untagged jobs</p>
                <p className="text-sm text-muted-foreground">
                  Creator: {ownerName || 'unknown'}
                  {relatedJobs.length > 1 ? ` · ${relatedJobs.length} untagged jobs by this owner in the list` : ''}
                </p>
                {relatedJobs.length > 1 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {relatedJobs.slice(0, 8).map((row) => (
                      <li key={`${row.workspace_id}-${row.job_id}`}>{row.name}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {!isAdmin ? (
                <Alert>
                  <AlertTitle>Administrator role required</AlertTitle>
                  <AlertDescription>
                    Viewing owner groups and creating usage policies is limited to administrators.
                  </AlertDescription>
                </Alert>
              ) : identity?.principalKind === 'service_principal' ? (
                <Alert>
                  <AlertTitle>Service principal owner</AlertTitle>
                  <AlertDescription>
                    This job was created by a service principal. Group membership is not expanded for service
                    principals in this workflow.
                  </AlertDescription>
                </Alert>
              ) : (
                <QueryPanel
                  loading={loading}
                  error={error}
                  empty={!identity?.groups.length}
                  emptyTitle="No groups for this owner"
                  emptyDescription="Workspace identity returned no groups. Account groups are required to receive a serverless usage policy."
                >
                  <div className="space-y-3">
                    <Label>Groups for {identity?.displayName ?? ownerName}</Label>
                    <RadioGroup value={groupId} onValueChange={selectGroup}>
                      {(identity?.groups ?? []).map((group) => (
                        <div key={group.id} className="flex items-start gap-2">
                          <RadioGroupItem
                            value={group.id}
                            id={`owner-group-${group.id}`}
                            disabled={group.kind === 'workspace'}
                          />
                          <Label htmlFor={`owner-group-${group.id}`} className="font-normal">
                            {group.displayName}
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {groupKindLabel(group.kind)}
                            </span>
                          </Label>
                        </div>
                      ))}
                    </RadioGroup>
                  </div>
                </QueryPanel>
              )}
              {isAdmin && selectedGroup && selectedGroup.kind !== 'workspace' ? (
                <div className="space-y-3">
                  <Alert>
                    <AlertTitle>What this policy does</AlertTitle>
                    <AlertDescription>
                      Creating the policy grants the selected group User on it so members can choose it on new or
                      edited serverless jobs, pipelines, and apps. Databricks does not attach the policy to existing
                      untagged jobs. Live create needs account API configuration; this workspace is usually dry-run.
                    </AlertDescription>
                  </Alert>
                  <div className="space-y-2">
                    <Label htmlFor="policy-name">Policy name</Label>
                    <Input
                      id="policy-name"
                      value={policyName}
                      onChange={(event) => setPolicyName(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="policy-tag-key">Custom tag key</Label>
                      <Input
                        id="policy-tag-key"
                        value={tagKey}
                        onChange={(event) => setTagKey(event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="policy-tag-value">Custom tag value</Label>
                      <Input
                        id="policy-tag-value"
                        value={tagValue}
                        onChange={(event) => setTagValue(event.target.value)}
                      />
                    </div>
                  </div>
                  {selectedGroup.kind === 'unknown' ? (
                    <p className="text-sm text-muted-foreground">
                      This group could not be classified. Account groups succeed; workspace-local groups fail at
                      apply.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {message ? <p className="text-sm text-destructive">{message}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            {isAdmin ? (
              <Button
                disabled={!payload || !selectedGroup || selectedGroup.kind === 'workspace' || !policyName || !tagKey || !tagValue}
                onClick={() => {
                  if (!payload) return;
                  setMessage(null);
                  void adminApi
                    .previewBudgetPolicy(payload)
                    .then((result) => {
                      setPreview(result);
                      setConfirmOpen(true);
                    })
                    .catch((reason: unknown) =>
                      setMessage(reason instanceof Error ? reason.message : 'Preview failed'),
                    );
                }}
              >
                Preview policy for group
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        preview={preview}
        pending={pending}
        onConfirm={() => {
          if (!payload) {
            return;
          }
          setPending(true);
          void adminApi
            .applyBudgetPolicy({ ...payload, confirmed: true })
            .then(() => {
              setMessage(null);
              setConfirmOpen(false);
              onClose();
            })
            .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Apply failed'))
            .finally(() => setPending(false));
        }}
      />
    </>
  );
}

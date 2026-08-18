import { describe, expect, it, vi } from 'vitest';
import { mergeBudgetPolicyUserGrant, MutationExecutor } from './executor';

describe('MutationExecutor dry run', () => {
  it('records an audit event and does not apply a live mutation', async () => {
    process.env.ADMIN_INSIGHTS_EXECUTION_MODE = 'dry_run';
    const writeAuditEvent = vi.fn().mockResolvedValue(undefined);
    const executor = new MutationExecutor({ writeAuditEvent });
    const mutate = vi.fn(() => Promise.reject(new Error('live mutation should not run')));

    const result = await executor.commit(
      { get: () => undefined },
      'josh.melton@databricks.com',
      {
        action: 'set_job_tags',
        mode: 'dry_run',
        targetType: 'job',
        targetId: '1',
        targetName: 'etl',
        before: {},
        after: {},
        reversible: true,
      },
      mutate,
    );

    expect(result.applied).toBe(false);
    expect(result.error).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    expect(writeAuditEvent).toHaveBeenCalledOnce();
    expect(writeAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      actor: 'josh.melton@databricks.com',
      action: 'set_job_tags.dry_run',
      outcome: 'info',
    });
  });

  it('rejects workspace-local groups before previewing a budget policy', async () => {
    const executor = new MutationExecutor({ writeAuditEvent: vi.fn() });
    await expect(
      executor.previewCreateBudgetPolicy(
        { get: () => undefined },
        {
          jobId: '99',
          jobName: 'untagged-etl',
          ownerUserName: 'owner@example.com',
          groupId: '7',
          groupDisplayName: 'local-ops',
          groupKind: 'workspace',
          policyName: 'serverless-local',
          customTags: { team: 'local-ops' },
        },
      ),
    ).rejects.toThrow('Workspace-local groups');
  });

  it('merges a group onto the budgetPolicy.user grant', () => {
    expect(mergeBudgetPolicyUserGrant(undefined, 'groups/42')).toEqual([
      { role: 'roles/budgetPolicy.user', principals: ['groups/42'] },
    ]);
    expect(
      mergeBudgetPolicyUserGrant(
        [{ role: 'roles/budgetPolicy.manager', principals: ['users/admin@example.com'] }],
        'groups/42',
      ),
    ).toEqual([
      { role: 'roles/budgetPolicy.manager', principals: ['users/admin@example.com'] },
      { role: 'roles/budgetPolicy.user', principals: ['groups/42'] },
    ]);
    expect(
      mergeBudgetPolicyUserGrant(
        [{ role: 'roles/budgetPolicy.user', principals: ['groups/1'] }],
        'groups/42',
      ),
    ).toEqual([{ role: 'roles/budgetPolicy.user', principals: ['groups/1', 'groups/42'] }]);
  });
});

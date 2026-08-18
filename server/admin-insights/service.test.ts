import { describe, expect, it, vi } from 'vitest';
import { AdminInsightsService } from './service';
import { getExecutionMode } from './executor';
import type { AdminInsightsStore } from './store';
import type { IdentityResolver } from './identity';
import type { MutationExecutor } from './executor';
import type { Actor } from '../../shared/admin-insights';

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    email: 'admin@example.com',
    displayName: 'Admin',
    roles: ['admin'],
    isAdmin: true,
    isRequester: true,
    isAuditor: true,
    ...overrides,
  };
}

describe('AdminInsightsService', () => {
  it('defaults execution mode to dry_run', () => {
    delete process.env.ADMIN_INSIGHTS_EXECUTION_MODE;
    expect(getExecutionMode()).toBe('dry_run');
  });

  it('exposes the workspace host for resource links', () => {
    const previous = process.env.DATABRICKS_HOST;
    process.env.DATABRICKS_HOST = 'https://example.cloud.databricks.com';
    const service = new AdminInsightsService(
      {} as AdminInsightsStore,
      {} as IdentityResolver,
      {} as MutationExecutor,
    );
    expect(service.getRuntimeConfiguration().workspaceHost).toBe('https://example.cloud.databricks.com');
    if (previous === undefined) {
      delete process.env.DATABRICKS_HOST;
    } else {
      process.env.DATABRICKS_HOST = previous;
    }
  });

  it('requires confirmation before mutations', async () => {
    const service = new AdminInsightsService(
      {} as AdminInsightsStore,
      {} as IdentityResolver,
      {} as MutationExecutor,
    );
    await expect(
      service.applyMutation(
        { get: vi.fn() },
        actor(),
        {
          type: 'job_tags',
          input: { jobId: 1, tags: { owner: 'platform' } },
        },
        false,
      ),
    ).rejects.toThrow('Confirmation is required before applying a mutation');
  });

  it('denies mutations to non-admins', async () => {
    const service = new AdminInsightsService(
      {} as AdminInsightsStore,
      {} as IdentityResolver,
      {} as MutationExecutor,
    );
    await expect(
      service.applyMutation(
        { get: vi.fn() },
        actor({ isAdmin: false, roles: ['requester'] }),
        {
          type: 'job_tags',
          input: { jobId: 1, tags: { owner: 'platform' } },
        },
        true,
      ),
    ).rejects.toThrow('Administrator role is required');
  });
});

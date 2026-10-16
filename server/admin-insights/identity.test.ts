import { describe, expect, it, vi } from 'vitest';
import { IdentityResolver, type IdentityRequest } from './identity';

function requestWithForwardedEmail(email: string | undefined): IdentityRequest {
  return {
    get: vi.fn((headerName: string) =>
      headerName.toLowerCase() === 'x-forwarded-email' ? email : undefined,
    ),
  };
}

describe('IdentityResolver', () => {
  it('derives requester and auditor permissions from stored app roles', async () => {
    const resolver = new IdentityResolver();

    const requester = await resolver.resolveActor(requestWithForwardedEmail('Requester@Example.com'), ['requester']);
    const auditor = await resolver.resolveActor(requestWithForwardedEmail('auditor@example.com'), ['auditor']);

    expect(requester).toMatchObject({
      email: 'requester@example.com',
      isAdmin: false,
      isRequester: true,
      isAuditor: false,
    });
    expect(auditor).toMatchObject({
      email: 'auditor@example.com',
      isAdmin: false,
      isRequester: false,
      isAuditor: true,
    });
  });

  it('treats bootstrap admins as administrators', async () => {
    process.env.ADMIN_INSIGHTS_BOOTSTRAP_ADMINS = 'admin@example.com';
    const resolver = new IdentityResolver();
    const actor = await resolver.resolveActor(requestWithForwardedEmail('admin@example.com'), []);
    expect(actor.isAdmin).toBe(true);
    expect(actor.isRequester).toBe(true);
  });

  it('rejects requests without a proxy identity', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_INSIGHTS_DEV_USER;
    const resolver = new IdentityResolver();
    expect(() => resolver.getActorEmail(requestWithForwardedEmail(undefined))).toThrow(
      'A trusted Databricks proxy identity header is required',
    );
    process.env.NODE_ENV = previous;
  });
});

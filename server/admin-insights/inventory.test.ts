import { describe, expect, it } from 'vitest';
import { classifyOwnerPrincipal, mapUserGroups } from './inventory';

describe('job owner identity mapping', () => {
  it('classifies emails as users and UUIDs as service principals', () => {
    expect(classifyOwnerPrincipal('owner@example.com')).toBe('user');
    expect(classifyOwnerPrincipal('93a5c42c-ac00-4288-9de0-c29a53ca7bb6')).toBe('service_principal');
    expect(classifyOwnerPrincipal('platform-bot')).toBe('unknown');
  });

  it('maps SCIM group membership and drops duplicates', () => {
    expect(
      mapUserGroups([
        { display: 'data-eng', value: '42' },
        { display: 'data-eng', value: '42' },
        { display: 'admins', value: '1' },
        { display: '   ', value: '' },
      ]),
    ).toEqual([
      { id: '1', displayName: 'admins', kind: 'unknown' },
      { id: '42', displayName: 'data-eng', kind: 'unknown' },
    ]);
  });
});

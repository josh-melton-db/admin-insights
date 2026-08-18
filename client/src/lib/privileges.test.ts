import { describe, expect, it } from 'vitest';
import { toSqlLikeFilter } from './filters';
import { formatGranteeKind, GRANTEE_KIND_OPTIONS, parsePrivilegeList, privilegeClassRank } from './privileges';

describe('toSqlLikeFilter', () => {
  it('returns empty for blank input', () => {
    expect(toSqlLikeFilter('')).toBe('');
    expect(toSqlLikeFilter('  ')).toBe('');
  });

  it('wraps plain text with wildcards', () => {
    expect(toSqlLikeFilter('finance')).toBe('%finance%');
  });

  it('keeps an explicit LIKE pattern', () => {
    expect(toSqlLikeFilter('finance%')).toBe('finance%');
    expect(toSqlLikeFilter('%admins')).toBe('%admins');
  });
});

describe('privilege helpers', () => {
  it('collects a unique sorted-stable privilege set from a CSV', () => {
    expect(parsePrivilegeList('SELECT, USE_SCHEMA, SELECT, BROWSE')).toEqual([
      'SELECT',
      'USE_SCHEMA',
      'BROWSE',
    ]);
  });

  it('ranks classes with READ first', () => {
    expect(privilegeClassRank('READ')).toBeLessThan(privilegeClassRank('WRITE_OR_CREATE'));
    expect(privilegeClassRank('WRITE_OR_CREATE')).toBeLessThan(privilegeClassRank('MANAGE_OR_ADMIN'));
    expect(privilegeClassRank('unknown')).toBeGreaterThan(privilegeClassRank('OTHER'));
  });

  it('labels principal types', () => {
    expect(formatGranteeKind('user')).toBe('User');
    expect(formatGranteeKind('group')).toBe('Group');
    expect(formatGranteeKind('service_principal')).toBe('Service principal');
    expect(GRANTEE_KIND_OPTIONS.map((option) => option.value)).toEqual([
      'all',
      'user',
      'group',
      'service_principal',
    ]);
  });
});

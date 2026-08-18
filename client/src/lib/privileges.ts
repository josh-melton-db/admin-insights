export const PRIVILEGE_CLASS_ORDER = ['READ', 'WRITE_OR_CREATE', 'MANAGE_OR_ADMIN', 'OTHER'] as const;

export type PrivilegeClass = (typeof PRIVILEGE_CLASS_ORDER)[number];

export const GRANTEE_KIND_OPTIONS = [
  { value: 'all', label: 'All principal types' },
  { value: 'user', label: 'Users' },
  { value: 'group', label: 'Groups' },
  { value: 'service_principal', label: 'Service principals' },
] as const;

export function parsePrivilegeList(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

export function privilegeClassRank(value: string | null | undefined): number {
  const index = PRIVILEGE_CLASS_ORDER.indexOf(value as PrivilegeClass);
  return index === -1 ? PRIVILEGE_CLASS_ORDER.length : index;
}

export function formatGranteeKind(value: string | null | undefined): string {
  switch (value) {
    case 'user':
      return 'User';
    case 'group':
      return 'Group';
    case 'service_principal':
      return 'Service principal';
    default:
      return value ? value.replaceAll('_', ' ') : 'Unknown';
  }
}

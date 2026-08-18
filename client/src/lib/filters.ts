export interface AdminFilters {
  startDate: string;
  endDate: string;
  workspaceScope: 'current' | 'all';
  catalogPattern: string;
}

export const DEFAULT_FILTERS: AdminFilters = {
  startDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  workspaceScope: 'current',
  catalogPattern: '%',
};

export function isNarrowCatalogPattern(pattern: string | null | undefined): boolean {
  const value = (pattern ?? '').trim();
  return value !== '' && value !== '%';
}

/** Empty means no filter. Otherwise LIKE-match the value, wrapping with % when the user omitted wildcards. */
export function toSqlLikeFilter(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.includes('%') ? trimmed : `%${trimmed}%`;
}

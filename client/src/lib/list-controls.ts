export const ALL_FILTER = 'all';
export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export const LIST_FETCH_LIMIT = 200;
export const COMPACT_LIST_FETCH_LIMIT = 100;

export const PAUSED_FILTER_OPTIONS = [
  { value: ALL_FILTER, label: 'All statuses' },
  { value: 'true', label: 'Paused' },
  { value: 'false', label: 'Not paused' },
];

export const SCALE_TO_ZERO_FILTER_OPTIONS = [
  { value: ALL_FILTER, label: 'All scale settings' },
  { value: 'does_not_scale_to_zero', label: 'Does not scale to zero' },
  { value: 'scales_to_zero', label: 'Scales to zero' },
  { value: 'unknown', label: 'Unknown' },
];

export function matchesSearch(haystack: string | null | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return (haystack ?? '').toLowerCase().includes(needle);
}

export function matchesPaused(paused: boolean | string | null | undefined, value: string): boolean {
  if (value === ALL_FILTER) {
    return true;
  }
  return String(paused) === value;
}

export function matchesScaleToZero(band: string | null | undefined, value: string): boolean {
  if (value === ALL_FILTER) {
    return true;
  }
  return (band ?? 'unknown') === value;
}

export function scaleToZeroLabel(band: string | null | undefined): string {
  if (band === 'does_not_scale_to_zero') {
    return 'Does not scale to zero';
  }
  if (band === 'scales_to_zero') {
    return 'Scales to zero';
  }
  return 'Unknown';
}

export function scaleToZeroListFilter<T extends { scale_to_zero_band?: string | null }>(label: string): {
  id: 'scaleToZero';
  label: string;
  options: typeof SCALE_TO_ZERO_FILTER_OPTIONS;
  match: (row: T, value: string) => boolean;
} {
  return {
    id: 'scaleToZero',
    label,
    options: SCALE_TO_ZERO_FILTER_OPTIONS,
    match: (row, value) => matchesScaleToZero(row.scale_to_zero_band, value),
  };
}

export function paginate<T>(
  rows: T[],
  page: number,
  pageSize: number,
): {
  page: number;
  pageCount: number;
  pageRows: T[];
  from: number;
  to: number;
  total: number;
} {
  const total = rows.length;
  const size = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = total === 0 ? 0 : (safePage - 1) * size;
  const pageRows = rows.slice(start, start + size);
  return {
    page: safePage,
    pageCount,
    pageRows,
    from: total === 0 ? 0 : start + 1,
    to: start + pageRows.length,
    total,
  };
}

export function uniqueFilterOptions(
  values: Array<string | null | undefined>,
  allLabel: string,
): Array<{ value: string; label: string }> {
  const unique = [...new Set(values.map((value) => (value ?? '').trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
  return [{ value: ALL_FILTER, label: allLabel }, ...unique.map((value) => ({ value, label: value }))];
}

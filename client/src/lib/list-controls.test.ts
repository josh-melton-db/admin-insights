import { describe, expect, it } from 'vitest';
import {
  ALL_FILTER,
  matchesPaused,
  matchesScaleToZero,
  matchesSearch,
  paginate,
  scaleToZeroLabel,
  uniqueFilterOptions,
} from './list-controls';

describe('list controls', () => {
  it('matches case-insensitive substring search', () => {
    expect(matchesSearch('untagged-etl', 'ETL')).toBe(true);
    expect(matchesSearch('untagged-etl', 'owner')).toBe(false);
    expect(matchesSearch('owner@example.com', '  ')).toBe(true);
  });

  it('matches paused filter sentinels', () => {
    expect(matchesPaused(true, ALL_FILTER)).toBe(true);
    expect(matchesPaused(true, 'true')).toBe(true);
    expect(matchesPaused(false, 'true')).toBe(false);
    expect(matchesPaused(false, 'false')).toBe(true);
  });

  it('matches scale-to-zero bands and labels unknown when missing', () => {
    expect(matchesScaleToZero('scales_to_zero', ALL_FILTER)).toBe(true);
    expect(matchesScaleToZero('does_not_scale_to_zero', 'does_not_scale_to_zero')).toBe(true);
    expect(matchesScaleToZero('scales_to_zero', 'does_not_scale_to_zero')).toBe(false);
    expect(matchesScaleToZero(null, 'unknown')).toBe(true);
    expect(scaleToZeroLabel('does_not_scale_to_zero')).toBe('Does not scale to zero');
    expect(scaleToZeroLabel('scales_to_zero')).toBe('Scales to zero');
    expect(scaleToZeroLabel(undefined)).toBe('Unknown');
  });

  it('paginates and clamps the current page', () => {
    const rows = [1, 2, 3, 4, 5];
    expect(paginate(rows, 2, 2)).toEqual({
      page: 2,
      pageCount: 3,
      pageRows: [3, 4],
      from: 3,
      to: 4,
      total: 5,
    });
    expect(paginate(rows, 99, 2).page).toBe(3);
    expect(paginate([], 1, 10)).toEqual({
      page: 1,
      pageCount: 1,
      pageRows: [],
      from: 0,
      to: 0,
      total: 0,
    });
  });

  it('builds select options with an All sentinel', () => {
    expect(uniqueFilterOptions(['job', 'app', 'job', ''], 'All resources')).toEqual([
      { value: ALL_FILTER, label: 'All resources' },
      { value: 'app', label: 'app' },
      { value: 'job', label: 'job' },
    ]);
  });
});

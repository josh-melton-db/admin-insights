import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@databricks/appkit-ui/react';
import { QueryPanel } from '@/components/QueryPanel';
import {
  ALL_FILTER,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  matchesSearch,
  paginate,
} from '@/lib/list-controls';

export type ListSelectFilter<T> = {
  id: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  match: (row: T, value: string) => boolean;
  defaultValue?: string;
};

export function FilteredTable<T>({
  loading,
  error,
  rows,
  emptyTitle,
  emptyDescription,
  getSearchText,
  searchLabel = 'Filter this list',
  searchPlaceholder = 'Search this list',
  filters = [],
  toolbar,
  children,
}: {
  loading: boolean;
  error: string | null;
  rows: T[];
  emptyTitle: string;
  emptyDescription: string;
  getSearchText: (row: T) => string;
  searchLabel?: string;
  searchPlaceholder?: string;
  filters?: Array<ListSelectFilter<T>>;
  toolbar?: ReactNode;
  children: (pageRows: T[]) => ReactNode;
}) {
  const searchId = useId();
  const pageSizeId = useId();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filterValues, setFilterValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(filters.map((filter) => [filter.id, filter.defaultValue ?? ALL_FILTER])),
  );

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (!matchesSearch(getSearchText(row), search)) {
        return false;
      }
      return filters.every((filter) => filter.match(row, filterValues[filter.id] ?? filter.defaultValue ?? ALL_FILTER));
    });
  }, [filterValues, filters, getSearchText, rows, search]);

  const paged = paginate(filteredRows, page, pageSize);
  if (paged.page !== page) {
    setPage(paged.page);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-2">
          <Label htmlFor={searchId}>{searchLabel}</Label>
          <Input
            id={searchId}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={searchPlaceholder}
          />
        </div>
        {filters.map((filter) => {
          const selectId = `${searchId}-${filter.id}`;
          return (
            <div key={filter.id} className="min-w-40 space-y-2">
              <Label htmlFor={selectId}>{filter.label}</Label>
              <Select
                value={filterValues[filter.id] ?? filter.defaultValue ?? ALL_FILTER}
                onValueChange={(value) => {
                  setFilterValues((current) => ({ ...current, [filter.id]: value }));
                  setPage(1);
                }}
              >
                <SelectTrigger id={selectId}>
                  <SelectValue placeholder={filter.label} />
                </SelectTrigger>
                <SelectContent>
                  {filter.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
        {toolbar}
      </div>
      <QueryPanel
        loading={loading}
        error={error}
        empty={rows.length === 0}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
      >
        {filteredRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rows match these filters.</p>
        ) : (
          <div className="space-y-3">
            {children(paged.pageRows)}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Showing {paged.from}–{paged.to} of {paged.total}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor={pageSizeId} className="text-sm text-muted-foreground">
                  Rows per page
                </Label>
                <Select value={String(pageSize)} onValueChange={(value) => {
                  setPageSize(Number(value));
                  setPage(1);
                }}>
                  <SelectTrigger id={pageSizeId} size="sm" className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={paged.page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={paged.page >= paged.pageCount}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </QueryPanel>
    </div>
  );
}

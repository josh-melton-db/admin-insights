import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@databricks/appkit-ui/react';
import type { AdminFilters } from '@/lib/filters';

export function FilterBar({
  filters,
  onChange,
}: {
  filters: AdminFilters;
  onChange: (filters: AdminFilters) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <div className="space-y-2">
        <Label htmlFor="start-date">Start date</Label>
        <Input
          id="start-date"
          type="date"
          value={filters.startDate}
          onChange={(event) => onChange({ ...filters, startDate: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="end-date">End date</Label>
        <Input
          id="end-date"
          type="date"
          value={filters.endDate}
          onChange={(event) => onChange({ ...filters, endDate: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="workspace-scope">Workspace scope</Label>
        <Select
          value={filters.workspaceScope}
          onValueChange={(value) =>
            onChange({ ...filters, workspaceScope: value === 'all' ? 'all' : 'current' })
          }
        >
          <SelectTrigger id="workspace-scope">
            <SelectValue placeholder="Workspace scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">Current workspace</SelectItem>
            <SelectItem value="all">All visible workspaces</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="catalog-pattern">Catalog pattern</Label>
        <Input
          id="catalog-pattern"
          value={filters.catalogPattern}
          onChange={(event) => onChange({ ...filters, catalogPattern: event.target.value || '%' })}
          placeholder="%"
        />
      </div>
    </div>
  );
}

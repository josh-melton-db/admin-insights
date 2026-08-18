import type { Dispatch, SetStateAction } from 'react';
import type { DashboardSummary } from '../../../shared/admin-insights';
import type { CurrentIdentity } from '@/lib/admin-api';
import type { AdminFilters } from '@/lib/filters';

export interface AdminOutletContext {
  filters: AdminFilters;
  setFilters: Dispatch<SetStateAction<AdminFilters>>;
  identity: CurrentIdentity | null;
  summary: DashboardSummary | null;
}

import { useCallback, useEffect, useState } from 'react';
import type {
  AccessRequest,
  Actor,
  AuditEvent,
  DashboardSummary,
  Finding,
  InventoryItem,
  JobOwnerIdentity,
  MutationPreview,
  MutationResult,
  RuntimeConfiguration,
  UsagePolicy,
} from '../../../shared/admin-insights';

export interface CurrentIdentity {
  actor: Actor;
  runtime: RuntimeConfiguration;
}

interface ApiErrorResponse {
  error?: string;
  details?: Array<{ path: string; message: string }>;
}

export class AdminApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    const details = error.details?.map((item) => `${item.path}: ${item.message}`).join(', ');
    throw new AdminApiError(details || error.error || response.statusText, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));

  const refresh = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>(path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load admin insights');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh, setData };
}

export const adminApi = {
  whoami: () => api<CurrentIdentity>('/whoami'),
  summary: () => api<DashboardSummary>('/summary'),
  listRequests: () => api<AccessRequest[]>('/requests'),
  submitRequest: (payload: unknown) =>
    api<AccessRequest>('/requests', { method: 'POST', body: JSON.stringify(payload) }),
  approve: (id: string, note: string | null) =>
    api<AccessRequest>(`/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
  deny: (id: string, note: string | null) =>
    api<AccessRequest>(`/requests/${id}/deny`, { method: 'POST', body: JSON.stringify({ note }) }),
  listFindings: () => api<Finding[]>('/findings'),
  createFinding: (payload: unknown) =>
    api<Finding>('/findings', { method: 'POST', body: JSON.stringify(payload) }),
  progressFinding: (id: string, status: Finding['status'], note: string | null) =>
    api<Finding>(`/findings/${id}/status`, { method: 'POST', body: JSON.stringify({ status, note }) }),
  listAudit: () => api<AuditEvent[]>('/audit'),
  listJobs: () => api<InventoryItem[]>('/inventory/jobs'),
  listApps: () => api<InventoryItem[]>('/inventory/apps'),
  listServingEndpoints: () => api<InventoryItem[]>('/inventory/serving-endpoints'),
  listPolicies: () => api<UsagePolicy[]>('/policies'),
  listJobOwnerIdentity: (userName: string) =>
    api<JobOwnerIdentity>(`/identities/groups?userName=${encodeURIComponent(userName)}`),
  previewUcTag: (payload: unknown) =>
    api<MutationPreview>('/actions/uc-tag/preview', { method: 'POST', body: JSON.stringify(payload) }),
  applyUcTag: (payload: unknown) =>
    api<MutationResult>('/actions/uc-tag', { method: 'POST', body: JSON.stringify(payload) }),
  previewJobTags: (payload: unknown) =>
    api<MutationPreview>('/actions/job-tags/preview', { method: 'POST', body: JSON.stringify(payload) }),
  applyJobTags: (payload: unknown) =>
    api<MutationResult>('/actions/job-tags', { method: 'POST', body: JSON.stringify(payload) }),
  previewJobPolicy: (payload: unknown) =>
    api<MutationPreview>('/actions/job-policy/preview', { method: 'POST', body: JSON.stringify(payload) }),
  applyJobPolicy: (payload: unknown) =>
    api<MutationResult>('/actions/job-policy', { method: 'POST', body: JSON.stringify(payload) }),
  previewAppPolicy: (payload: unknown) =>
    api<MutationPreview>('/actions/app-policy/preview', { method: 'POST', body: JSON.stringify(payload) }),
  applyAppPolicy: (payload: unknown) =>
    api<MutationResult>('/actions/app-policy', { method: 'POST', body: JSON.stringify(payload) }),
  previewBudgetPolicy: (payload: unknown) =>
    api<MutationPreview>('/actions/budget-policy/preview', { method: 'POST', body: JSON.stringify(payload) }),
  applyBudgetPolicy: (payload: unknown) =>
    api<MutationResult>('/actions/budget-policy', { method: 'POST', body: JSON.stringify(payload) }),
};

export const RESOURCE_TYPES = [
  'catalog',
  'schema',
  'table',
  'volume',
  'job',
  'app',
  'notebook',
  'dashboard',
  'genie',
  'serving_endpoint',
] as const;

export const PRINCIPAL_TYPES = ['user', 'service_principal'] as const;

export const REQUEST_STATUSES = [
  'submitted',
  'approved',
  'denied',
  'in_progress',
  'completed',
  'failed',
] as const;

export const FINDING_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved', 'dismissed'] as const;

export const EXECUTION_MODES = ['dry_run', 'live'] as const;

export const MUTATION_ACTIONS = [
  'set_uc_tag',
  'set_workspace_tag',
  'set_job_tags',
  'assign_job_policy',
  'assign_app_policy',
  'create_budget_policy',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type MutationAction = (typeof MUTATION_ACTIONS)[number];

export interface Actor {
  email: string;
  displayName: string;
  roles: string[];
  isAdmin: boolean;
  isRequester: boolean;
  isAuditor: boolean;
}

export interface RuntimeConfiguration {
  executionMode: ExecutionMode;
  allowedActions: readonly MutationAction[];
  workspaceHost: string | null;
}

export interface AccessRequest {
  id: string;
  requestedBy: string;
  requestedFor: string;
  subjectPrincipalId: string;
  subjectPrincipalType: PrincipalType;
  subjectDisplayName: string;
  resourceType: ResourceType;
  resourceName: string;
  requestedPrivileges: string[];
  justification: string;
  requestMode: 'self' | 'on_behalf_of' | 'service_principal';
  status: RequestStatus;
  decisionNote: string | null;
  approver: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  requestId: string | null;
  findingId: string | null;
  actor: string;
  action: string;
  outcome: 'success' | 'failure' | 'info';
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Finding {
  id: string;
  findingType: string;
  targetType: ResourceType;
  targetId: string;
  targetName: string;
  severity: 'low' | 'medium' | 'high';
  status: FindingStatus;
  summary: string;
  evidence: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FindingStatusHistory {
  id: string;
  findingId: string;
  actor: string;
  fromStatus: FindingStatus | null;
  toStatus: FindingStatus;
  note: string | null;
  createdAt: string;
}

export interface MutationPreview {
  action: MutationAction;
  mode: ExecutionMode;
  targetType: ResourceType;
  targetId: string;
  targetName: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reversible: boolean;
}

export interface MutationResult extends MutationPreview {
  applied: boolean;
  auditEventId: string;
  error: string | null;
}

export interface UsagePolicy {
  policyId: string;
  policyName: string;
  customTags: Record<string, string>;
}

export type IdentityGroupKind = 'account' | 'workspace' | 'unknown';

export interface IdentityGroup {
  id: string;
  displayName: string;
  kind: IdentityGroupKind;
}

export interface JobOwnerIdentity {
  userName: string;
  displayName: string | null;
  userId: string | null;
  principalKind: 'user' | 'service_principal' | 'unknown';
  groups: IdentityGroup[];
}

export interface InventoryItem {
  id: string;
  name: string;
  type: ResourceType;
  tags: Record<string, string>;
  usagePolicyId: string | null;
  creator: string | null;
  updatedAt: string | null;
}

export interface DashboardSummary {
  openFindings: number;
  pendingRequests: number;
  recentAuditEvents: number;
  executionMode: ExecutionMode;
  asOf: string;
}

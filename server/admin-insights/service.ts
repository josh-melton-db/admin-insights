import { randomUUID } from 'node:crypto';
import type {
  AccessRequest,
  Actor,
  DashboardSummary,
  Finding,
  FindingStatus,
  MutationResult,
  PrincipalType,
  RequestStatus,
  ResourceType,
  RuntimeConfiguration,
} from '../../shared/admin-insights';
import { MUTATION_ACTIONS } from '../../shared/admin-insights';
import type { MutationExecutor } from './executor';
import { getExecutionMode } from './executor';
import type { IdentityRequest, IdentityResolver } from './identity';
import { InventoryAdapter } from './inventory';
import type { AdminInsightsStore } from './store';

const ALLOWED_FINDING_TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
  open: ['acknowledged', 'in_progress', 'dismissed'],
  acknowledged: ['in_progress', 'resolved', 'dismissed'],
  in_progress: ['resolved', 'dismissed', 'open'],
  resolved: ['open'],
  dismissed: ['open'],
};

export class AdminInsightsService {
  public constructor(
    private readonly store: AdminInsightsStore,
    private readonly identity: IdentityResolver,
    private readonly executor: MutationExecutor,
    private readonly inventory = new InventoryAdapter(),
  ) {}

  getRuntimeConfiguration(): RuntimeConfiguration {
    return {
      executionMode: getExecutionMode(),
      allowedActions: MUTATION_ACTIONS,
      workspaceHost: process.env.DATABRICKS_HOST ?? null,
    };
  }

  async actorForRequest(req: IdentityRequest): Promise<Actor> {
    const email = this.identity.getActorEmail(req);
    const roles = await this.store.getRoles(email);
    return this.identity.resolveActor(req, roles);
  }

  async getSummary(_actor: Actor): Promise<DashboardSummary> {
    return {
      openFindings: await this.store.countOpenFindings(),
      pendingRequests: await this.store.countPendingRequests(),
      recentAuditEvents: await this.store.countRecentAuditEvents(),
      executionMode: getExecutionMode(),
      asOf: new Date().toISOString(),
    };
  }

  requireAdmin(actor: Actor): void {
    if (!actor.isAdmin) {
      throw new Error('Administrator role is required');
    }
  }

  requireRequester(actor: Actor): void {
    if (!actor.isRequester) {
      throw new Error('Requester role is required');
    }
  }

  async submitRequest(
    actor: Actor,
    input: {
      requestedFor?: string | null;
      subjectPrincipalId?: string | null;
      subjectPrincipalType: PrincipalType;
      subjectDisplayName?: string | null;
      resourceType: ResourceType;
      resourceName: string;
      requestedPrivileges: string[];
      justification: string;
      requestMode: AccessRequest['requestMode'];
      idempotencyKey?: string | null;
    },
  ): Promise<AccessRequest> {
    this.requireRequester(actor);
    const requestedFor = (input.requestedFor ?? actor.email).toLowerCase();
    const request = await this.store.createAccessRequest({
      requestedBy: actor.email,
      requestedFor,
      subjectPrincipalId: input.subjectPrincipalId ?? requestedFor,
      subjectPrincipalType: input.subjectPrincipalType,
      subjectDisplayName: input.subjectDisplayName ?? requestedFor,
      resourceType: input.resourceType,
      resourceName: input.resourceName,
      requestedPrivileges: input.requestedPrivileges,
      justification: input.justification,
      requestMode: input.requestMode,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    await this.store.writeAuditEvent({
      id: randomUUID(),
      requestId: request.id,
      findingId: null,
      actor: actor.email,
      action: 'access_request.submitted',
      outcome: 'success',
      message: 'Access request recorded in Lakebase',
      payload: { resourceName: request.resourceName, resourceType: request.resourceType },
    });
    return request;
  }

  async decideRequest(
    actor: Actor,
    requestId: string,
    decision: Extract<RequestStatus, 'approved' | 'denied'>,
    note: string | null,
  ): Promise<AccessRequest> {
    this.requireAdmin(actor);
    const request = await this.store.getAccessRequest(requestId);
    if (!request) {
      throw new Error('Access request was not found');
    }
    if (request.requestedBy === actor.email) {
      throw new Error('Self-approval is not allowed');
    }
    const updated = await this.store.transitionRequest(request.id, 'submitted', decision, {
      approver: actor.email,
      decisionNote: note,
    });
    await this.store.writeAuditEvent({
      id: randomUUID(),
      requestId: request.id,
      findingId: null,
      actor: actor.email,
      action: `access_request.${decision}`,
      outcome: 'success',
      message: note,
      payload: { decision },
    });
    return updated;
  }

  async listRequests(actor: Actor): Promise<AccessRequest[]> {
    this.requireRequester(actor);
    return this.store.listAccessRequests(actor);
  }

  async createFinding(
    actor: Actor,
    input: {
      findingType: string;
      targetType: ResourceType;
      targetId: string;
      targetName: string;
      severity: Finding['severity'];
      summary: string;
      evidence: Record<string, unknown>;
    },
  ): Promise<Finding> {
    this.requireRequester(actor);
    const finding = await this.store.createFinding({ ...input, createdBy: actor.email });
    await this.store.writeAuditEvent({
      id: randomUUID(),
      requestId: null,
      findingId: finding.id,
      actor: actor.email,
      action: 'finding.created',
      outcome: 'success',
      message: finding.summary,
      payload: { findingType: finding.findingType, targetName: finding.targetName },
    });
    return finding;
  }

  async progressFinding(actor: Actor, findingId: string, toStatus: FindingStatus, note: string | null): Promise<Finding> {
    this.requireAdmin(actor);
    const finding = await this.store.getFinding(findingId);
    if (!finding) {
      throw new Error('Finding was not found');
    }
    const allowed = ALLOWED_FINDING_TRANSITIONS[finding.status];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Finding is no longer able to move from ${finding.status} to ${toStatus}`);
    }
    const updated = await this.store.updateFindingStatus(finding.id, finding.status, toStatus, actor.email, note);
    await this.store.writeAuditEvent({
      id: randomUUID(),
      requestId: null,
      findingId: finding.id,
      actor: actor.email,
      action: 'finding.status_changed',
      outcome: 'success',
      message: note,
      payload: { from: finding.status, to: toStatus },
    });
    return updated;
  }

  async applyMutation(
    req: IdentityRequest,
    actor: Actor,
    kind:
      | { type: 'uc_tag'; input: Parameters<MutationExecutor['applyUcTag']>[2] }
      | { type: 'workspace_tag'; input: Parameters<MutationExecutor['applyWorkspaceTag']>[2] }
      | { type: 'job_tags'; input: Parameters<MutationExecutor['applyJobTags']>[2] }
      | { type: 'job_policy'; input: Parameters<MutationExecutor['applyJobPolicy']>[2] }
      | { type: 'app_policy'; input: Parameters<MutationExecutor['applyAppPolicy']>[2] }
      | { type: 'create_budget_policy'; input: Parameters<MutationExecutor['applyCreateBudgetPolicy']>[2] },
    confirmed: boolean,
  ): Promise<MutationResult> {
    this.requireAdmin(actor);
    if (!confirmed) {
      throw new Error('Confirmation is required before applying a mutation');
    }
    if (kind.type === 'uc_tag') {
      return this.executor.applyUcTag(req, actor.email, kind.input);
    }
    if (kind.type === 'workspace_tag') {
      return this.executor.applyWorkspaceTag(req, actor.email, kind.input);
    }
    if (kind.type === 'job_tags') {
      return this.executor.applyJobTags(req, actor.email, kind.input);
    }
    if (kind.type === 'job_policy') {
      return this.executor.applyJobPolicy(req, actor.email, kind.input);
    }
    if (kind.type === 'app_policy') {
      return this.executor.applyAppPolicy(req, actor.email, kind.input);
    }
    return this.executor.applyCreateBudgetPolicy(req, actor.email, kind.input);
  }

  previewUcTag(req: IdentityRequest, actor: Actor, input: Parameters<MutationExecutor['previewUcTag']>[1]) {
    this.requireAdmin(actor);
    return this.executor.previewUcTag(req, input);
  }

  previewWorkspaceTag(
    req: IdentityRequest,
    actor: Actor,
    input: Parameters<MutationExecutor['previewWorkspaceTag']>[1],
  ) {
    this.requireAdmin(actor);
    return this.executor.previewWorkspaceTag(req, input);
  }

  previewJobTags(req: IdentityRequest, actor: Actor, input: Parameters<MutationExecutor['previewJobTags']>[1]) {
    this.requireAdmin(actor);
    return this.executor.previewJobTags(req, input);
  }

  previewJobPolicy(req: IdentityRequest, actor: Actor, input: Parameters<MutationExecutor['previewJobPolicy']>[1]) {
    this.requireAdmin(actor);
    return this.executor.previewJobPolicy(req, input);
  }

  previewAppPolicy(req: IdentityRequest, actor: Actor, input: Parameters<MutationExecutor['previewAppPolicy']>[1]) {
    this.requireAdmin(actor);
    return this.executor.previewAppPolicy(req, input);
  }

  previewCreateBudgetPolicy(
    req: IdentityRequest,
    actor: Actor,
    input: Parameters<MutationExecutor['previewCreateBudgetPolicy']>[1],
  ) {
    this.requireAdmin(actor);
    return this.executor.previewCreateBudgetPolicy(req, input);
  }

  listJobs(req: IdentityRequest, actor: Actor) {
    this.requireAdmin(actor);
    return this.inventory.listJobs(req);
  }

  listApps(req: IdentityRequest, actor: Actor) {
    this.requireAdmin(actor);
    return this.inventory.listApps(req);
  }

  listServingEndpoints(req: IdentityRequest, actor: Actor) {
    this.requireAdmin(actor);
    return this.inventory.listServingEndpoints(req);
  }

  listPolicies(req: IdentityRequest, actor: Actor) {
    this.requireAdmin(actor);
    return this.inventory.listPolicies(req);
  }

  listJobOwnerIdentity(req: IdentityRequest, actor: Actor, userName: string) {
    this.requireAdmin(actor);
    return this.inventory.listJobOwnerIdentity(req, userName);
  }

  listFindings(actor: Actor) {
    if (!actor.isAdmin && !actor.isAuditor) {
      throw new Error('Auditor role is required');
    }
    return this.store.listFindings();
  }

  listAudit(actor: Actor) {
    if (!actor.isAdmin && !actor.isAuditor) {
      throw new Error('Auditor role is required');
    }
    return this.store.listAuditEvents(100);
  }

  async grantRole(actor: Actor, email: string, role: 'admin' | 'requester' | 'auditor'): Promise<void> {
    this.requireAdmin(actor);
    await this.store.grantRole(email, role, actor.email);
  }
}

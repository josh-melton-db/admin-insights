import { randomUUID } from 'node:crypto';
import type {
  ExecutionMode,
  MutationAction,
  MutationPreview,
  MutationResult,
  ResourceType,
} from '../../shared/admin-insights';
import type { IdentityRequest } from './identity';
import { InventoryAdapter } from './inventory';
import type { AdminInsightsStore } from './store';
import { getOboWorkspaceClient, executeOboSql, quoteSqlIdent, quoteSqlLiteral, requestJson, getOboAccountClient } from './workspace-client';

export type MutationStore = Pick<AdminInsightsStore, 'writeAuditEvent'>;

export function getExecutionMode(): ExecutionMode {
  return process.env.ADMIN_INSIGHTS_EXECUTION_MODE === 'live' ? 'live' : 'dry_run';
}

export interface UcTagInput {
  entityType: 'catalogs' | 'schemas' | 'tables' | 'columns' | 'volumes';
  entityName: string;
  tagKey: string;
  tagValue: string;
}

export interface WorkspaceTagInput {
  entityType: 'apps' | 'dashboards' | 'geniespaces' | 'notebooks';
  entityId: string;
  tagKey: string;
  tagValue: string;
}

export interface JobTagsInput {
  jobId: number;
  tags: Record<string, string>;
}

export interface JobPolicyInput {
  jobId: number;
  policyId: string;
}

export interface AppPolicyInput {
  appName: string;
  policyId: string;
}

export interface CreateBudgetPolicyInput {
  jobId: string;
  jobName: string;
  ownerUserName: string;
  groupId: string;
  groupDisplayName: string;
  groupKind: 'account' | 'workspace' | 'unknown';
  policyName: string;
  customTags: Record<string, string>;
}

function resourceTypeForWorkspaceEntity(
  entityType: WorkspaceTagInput['entityType'],
): ResourceType {
  if (entityType === 'apps') return 'app';
  if (entityType === 'dashboards') return 'dashboard';
  if (entityType === 'geniespaces') return 'genie';
  return 'notebook';
}

function resourceTypeForUcEntity(entityType: UcTagInput['entityType']): ResourceType {
  if (entityType === 'catalogs') return 'catalog';
  if (entityType === 'schemas') return 'schema';
  if (entityType === 'volumes') return 'volume';
  return 'table';
}

function ucTagAlterSql(input: UcTagInput): string {
  const objectName = quoteSqlIdent(input.entityName);
  const tag = `${quoteSqlLiteral(input.tagKey)} = ${quoteSqlLiteral(input.tagValue)}`;
  if (input.entityType === 'catalogs') {
    return `ALTER CATALOG ${objectName} SET TAGS (${tag})`;
  }
  if (input.entityType === 'schemas') {
    return `ALTER SCHEMA ${objectName} SET TAGS (${tag})`;
  }
  if (input.entityType === 'volumes') {
    return `ALTER VOLUME ${objectName} SET TAGS (${tag})`;
  }
  if (input.entityType === 'columns') {
    const parts = input.entityName.split('.');
    const column = parts.pop() ?? input.entityName;
    const table = quoteSqlIdent(parts.join('.'));
    return `ALTER TABLE ${table} ALTER COLUMN ${quoteSqlIdent(column)} SET TAGS (${tag})`;
  }
  return `ALTER TABLE ${objectName} SET TAGS (${tag})`;
}

export class MutationExecutor {
  public constructor(
    private readonly store: MutationStore,
    private readonly inventory = new InventoryAdapter(),
  ) {}

  async previewUcTag(req: IdentityRequest, input: UcTagInput): Promise<MutationPreview> {
    const before = await this.inventory.listUcTags(req, input.entityType, input.entityName);
    return this.preview('set_uc_tag', resourceTypeForUcEntity(input.entityType), input.entityName, input.entityName, {
      tags: before,
    }, {
      tags: { ...before, [input.tagKey]: input.tagValue },
    });
  }

  async applyUcTag(req: IdentityRequest, actor: string, input: UcTagInput): Promise<MutationResult> {
    const preview = await this.previewUcTag(req, input);
    return this.commit(req, actor, preview, async () => {
      await executeOboSql(req, ucTagAlterSql(input));
    });
  }

  async previewWorkspaceTag(req: IdentityRequest, input: WorkspaceTagInput): Promise<MutationPreview> {
    const before = await this.inventory.listWorkspaceTags(req, input.entityType, input.entityId);
    return this.preview(
      'set_workspace_tag',
      resourceTypeForWorkspaceEntity(input.entityType),
      input.entityId,
      input.entityId,
      { tags: before },
      { tags: { ...before, [input.tagKey]: input.tagValue } },
    );
  }

  async applyWorkspaceTag(
    req: IdentityRequest,
    actor: string,
    input: WorkspaceTagInput,
  ): Promise<MutationResult> {
    const preview = await this.previewWorkspaceTag(req, input);
    return this.commit(req, actor, preview, async () => {
      const client = getOboWorkspaceClient(req);
      await requestJson(client, {
        path: '/api/2.0/entity-tag-assignments',
        method: 'POST',
        payload: {
          entity_type: input.entityType,
          entity_id: input.entityId,
          tag_key: input.tagKey,
          tag_value: input.tagValue,
        },
      });
    });
  }

  async previewJobTags(req: IdentityRequest, input: JobTagsInput): Promise<MutationPreview> {
    const client = getOboWorkspaceClient(req);
    const job = await client.jobs.get({ job_id: input.jobId });
    const currentTags = job.settings?.tags ?? {};
    return this.preview(
      'set_job_tags',
      'job',
      String(input.jobId),
      job.settings?.name ?? String(input.jobId),
      { tags: currentTags },
      { tags: { ...currentTags, ...input.tags } },
    );
  }

  async applyJobTags(req: IdentityRequest, actor: string, input: JobTagsInput): Promise<MutationResult> {
    const preview = await this.previewJobTags(req, input);
    return this.commit(req, actor, preview, async () => {
      const client = getOboWorkspaceClient(req);
      const afterTags = preview.after.tags;
      await client.jobs.update({
        job_id: input.jobId,
        new_settings: {
          tags: afterTags && typeof afterTags === 'object' && !Array.isArray(afterTags)
            ? Object.fromEntries(
                Object.entries(afterTags).map(([key, value]) => [key, String(value)]),
              )
            : input.tags,
        },
      });
    });
  }

  async previewJobPolicy(req: IdentityRequest, input: JobPolicyInput): Promise<MutationPreview> {
    const client = getOboWorkspaceClient(req);
    const job = await client.jobs.get({ job_id: input.jobId });
    return this.preview(
      'assign_job_policy',
      'job',
      String(input.jobId),
      job.settings?.name ?? String(input.jobId),
      { budgetPolicyId: job.settings?.budget_policy_id ?? job.effective_budget_policy_id ?? null },
      { budgetPolicyId: input.policyId },
    );
  }

  async applyJobPolicy(req: IdentityRequest, actor: string, input: JobPolicyInput): Promise<MutationResult> {
    const preview = await this.previewJobPolicy(req, input);
    return this.commit(req, actor, preview, async () => {
      const client = getOboWorkspaceClient(req);
      await client.jobs.update({
        job_id: input.jobId,
        new_settings: { budget_policy_id: input.policyId },
      });
    });
  }

  async previewAppPolicy(req: IdentityRequest, input: AppPolicyInput): Promise<MutationPreview> {
    const client = getOboWorkspaceClient(req);
    const app = await client.apps.get({ name: input.appName });
    return this.preview(
      'assign_app_policy',
      'app',
      input.appName,
      app.name,
      { budgetPolicyId: app.budget_policy_id ?? app.effective_budget_policy_id ?? null },
      { usagePolicyId: input.policyId },
    );
  }

  async applyAppPolicy(req: IdentityRequest, actor: string, input: AppPolicyInput): Promise<MutationResult> {
    const preview = await this.previewAppPolicy(req, input);
    return this.commit(req, actor, preview, async () => {
      const client = getOboWorkspaceClient(req);
      await client.apps.createUpdate({
        app_name: input.appName,
        update_mask: 'budget_policy_id',
        app: {
          name: input.appName,
          budget_policy_id: input.policyId,
        },
      });
    });
  }

  async previewCreateBudgetPolicy(_req: IdentityRequest, input: CreateBudgetPolicyInput): Promise<MutationPreview> {
    if (input.groupKind === 'workspace') {
      throw new Error(
        'Workspace-local groups cannot receive account serverless usage policies. Choose an account group.',
      );
    }
    return this.preview(
      'create_budget_policy',
      'job',
      input.jobId,
      input.jobName,
      { budgetPolicyId: null, groupId: null },
      {
        policyName: input.policyName,
        customTags: input.customTags,
        ownerUserName: input.ownerUserName,
        groupId: input.groupId,
        groupDisplayName: input.groupDisplayName,
        groupKind: input.groupKind,
        grant: 'roles/budgetPolicy.user',
        principal: `groups/${input.groupId}`,
        existingJobsNote:
          'Existing jobs are not auto-assigned this policy. The group can select it on new or edited serverless jobs.',
      },
    );
  }

  async applyCreateBudgetPolicy(
    req: IdentityRequest,
    actor: string,
    input: CreateBudgetPolicyInput,
  ): Promise<MutationResult> {
    const preview = await this.previewCreateBudgetPolicy(req, input);
    return this.commit(req, actor, preview, async () => {
      const account = getOboAccountClient(req);
      const accountId = process.env.DATABRICKS_ACCOUNT_ID;
      if (!account || !accountId) {
        throw new Error(
          'DATABRICKS_ACCOUNT_HOST and DATABRICKS_ACCOUNT_ID are required to create serverless usage policies',
        );
      }
      const created = await account.budgetPolicy.create({
        request_id: randomUUID(),
        policy: {
          policy_name: input.policyName,
          custom_tags: Object.entries(input.customTags).map(([key, value]) => ({ key, value })),
        },
      });
      const policyId = created.policy_id;
      if (!policyId) {
        throw new Error('Created usage policy did not return a policy id');
      }
      const ruleSetName = `accounts/${accountId}/budgetPolicies/${policyId}/ruleSets/default`;
      const workspace = getOboWorkspaceClient(req);
      const existing = await workspace.accountAccessControlProxy
        .getRuleSet({ name: ruleSetName, etag: '' })
        .catch(() => ({ name: ruleSetName, etag: '', grant_rules: [] }));
      await workspace.accountAccessControlProxy.updateRuleSet({
        name: ruleSetName,
        rule_set: {
          name: ruleSetName,
          etag: existing.etag,
          grant_rules: mergeBudgetPolicyUserGrant(existing.grant_rules, `groups/${input.groupId}`),
        },
      });
    });
  }

  private preview(
    action: MutationAction,
    targetType: ResourceType,
    targetId: string,
    targetName: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): MutationPreview {
    return {
      action,
      mode: getExecutionMode(),
      targetType,
      targetId,
      targetName,
      before,
      after,
      reversible: true,
    };
  }

  async commit(
    _req: IdentityRequest,
    actor: string,
    preview: MutationPreview,
    mutate: () => Promise<void>,
  ): Promise<MutationResult> {
    const auditEventId = randomUUID();
    const mode = getExecutionMode();
    if (mode === 'dry_run') {
      await this.store.writeAuditEvent({
        id: auditEventId,
        requestId: null,
        findingId: null,
        actor,
        action: `${preview.action}.dry_run`,
        outcome: 'info',
        message: 'Dry-run preview recorded; no workspace mutation was applied',
        payload: { preview },
      });
      return { ...preview, mode, applied: false, auditEventId, error: null };
    }

    try {
      await mutate();
      await this.store.writeAuditEvent({
        id: auditEventId,
        requestId: null,
        findingId: null,
        actor,
        action: `${preview.action}.live`,
        outcome: 'success',
        message: 'Mutation applied with the signed-in user identity',
        payload: { preview },
      });
      return { ...preview, mode, applied: true, auditEventId, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown mutation error';
      await this.store.writeAuditEvent({
        id: auditEventId,
        requestId: null,
        findingId: null,
        actor,
        action: `${preview.action}.live`,
        outcome: 'failure',
        message,
        payload: { preview },
      });
      return { ...preview, mode, applied: false, auditEventId, error: message };
    }
  }
}

export function mergeBudgetPolicyUserGrant(
  rules: Array<{ role: string; principals?: string[] }> | undefined,
  principal: string,
): Array<{ role: string; principals: string[] }> {
  const next = (rules ?? []).map((rule) => ({
    role: rule.role,
    principals: [...(rule.principals ?? [])],
  }));
  const existing = next.find((rule) => rule.role === 'roles/budgetPolicy.user');
  if (existing) {
    if (!existing.principals.includes(principal)) {
      existing.principals.push(principal);
    }
    return next;
  }
  next.push({ role: 'roles/budgetPolicy.user', principals: [principal] });
  return next;
}

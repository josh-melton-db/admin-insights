import { z } from 'zod';
import type { IdentityGroup, InventoryItem, JobOwnerIdentity, ResourceType, UsagePolicy } from '../../shared/admin-insights';
import type { IdentityRequest } from './identity';
import { quotedScimValue } from './identity';
import { getOboAccountClient, getOboWorkspaceClient, executeOboSql, quoteSqlLiteral, requestJson } from './workspace-client';

const JobListItem = z.object({
  job_id: z.number().optional(),
  creator_user_name: z.string().nullable().optional(),
  settings: z
    .object({
      name: z.string().optional(),
      tags: z.record(z.string(), z.string()).optional(),
      budget_policy_id: z.string().optional(),
    })
    .optional(),
});

const AppListItem = z.object({
  name: z.string(),
  creator: z.string().optional(),
  update_time: z.string().optional(),
  budget_policy_id: z.string().optional(),
  effective_budget_policy_id: z.string().optional(),
});

const ServingEndpointItem = z.object({
  name: z.string(),
  creator: z.string().optional(),
  creation_timestamp: z.number().optional(),
});

const BudgetPolicyItem = z.object({
  policy_id: z.string().optional(),
  policy_name: z.string().optional(),
  custom_tags: z
    .array(z.object({ key: z.string().optional(), value: z.string().optional() }))
    .optional(),
});

const TagAssignment = z.object({
  tag_key: z.string(),
  tag_value: z.string().optional(),
});

function tagsFromRecord(value: Record<string, string> | undefined): Record<string, string> {
  return value ?? {};
}

async function collect<T>(iterable: AsyncIterable<T>, limit: number): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

export class InventoryAdapter {
  async listJobs(req: IdentityRequest, limit = 50): Promise<InventoryItem[]> {
    const client = getOboWorkspaceClient(req);
    const jobs = await collect(client.jobs.list({ limit, expand_tasks: false }), limit);
    return jobs.flatMap((job) => {
      const parsed = JobListItem.safeParse(job);
      if (!parsed.success || parsed.data.job_id === undefined) {
        return [];
      }
      return [
        {
          id: String(parsed.data.job_id),
          name: parsed.data.settings?.name ?? String(parsed.data.job_id),
          type: 'job' as ResourceType,
          tags: tagsFromRecord(parsed.data.settings?.tags),
          usagePolicyId: parsed.data.settings?.budget_policy_id ?? null,
          creator: parsed.data.creator_user_name ?? null,
          updatedAt: null,
        },
      ];
    });
  }

  async listApps(req: IdentityRequest, limit = 50): Promise<InventoryItem[]> {
    const client = getOboWorkspaceClient(req);
    const apps = await collect(client.apps.list({}), limit);
    return apps.flatMap((app) => {
      const parsed = AppListItem.safeParse(app);
      if (!parsed.success) {
        return [];
      }
      return [
        {
          id: parsed.data.name,
          name: parsed.data.name,
          type: 'app' as ResourceType,
          tags: {},
          usagePolicyId: parsed.data.budget_policy_id ?? parsed.data.effective_budget_policy_id ?? null,
          creator: parsed.data.creator ?? null,
          updatedAt: parsed.data.update_time ?? null,
        },
      ];
    });
  }

  async listServingEndpoints(req: IdentityRequest, limit = 50): Promise<InventoryItem[]> {
    const client = getOboWorkspaceClient(req);
    const endpoints = await collect(client.servingEndpoints.list(), limit);
    return endpoints.flatMap((endpoint) => {
      const parsed = ServingEndpointItem.safeParse(endpoint);
      if (!parsed.success) {
        return [];
      }
      return [
        {
          id: parsed.data.name,
          name: parsed.data.name,
          type: 'serving_endpoint' as ResourceType,
          tags: {},
          usagePolicyId: null,
          creator: parsed.data.creator ?? null,
          updatedAt: parsed.data.creation_timestamp
            ? new Date(parsed.data.creation_timestamp).toISOString()
            : null,
        },
      ];
    });
  }

  async listPolicies(req: IdentityRequest): Promise<UsagePolicy[]> {
    const account = getOboAccountClient(req);
    if (!account) {
      return [];
    }
    const policies = await collect(account.budgetPolicy.list({}), 100);
    return policies.flatMap((policy) => {
      const parsed = BudgetPolicyItem.safeParse(policy);
      if (!parsed.success || !parsed.data.policy_id) {
        return [];
      }
      const customTags: Record<string, string> = {};
      for (const tag of parsed.data.custom_tags ?? []) {
        if (tag.key && tag.value) {
          customTags[tag.key] = tag.value;
        }
      }
      return [
        {
          policyId: parsed.data.policy_id,
          policyName: parsed.data.policy_name ?? parsed.data.policy_id,
          customTags,
        },
      ];
    });
  }

  async listJobOwnerIdentity(req: IdentityRequest, userName: string): Promise<JobOwnerIdentity> {
    const principalKind = classifyOwnerPrincipal(userName);
    if (principalKind === 'service_principal') {
      return {
        userName,
        displayName: null,
        userId: null,
        principalKind,
        groups: [],
      };
    }
    const client = getOboWorkspaceClient(req);
    const filter = `userName eq "${quotedScimValue(userName)}"`;
    for await (const user of client.usersV2.list({
      filter,
      attributes: 'id,userName,displayName,groups',
      count: 1,
    })) {
      const membership = mapUserGroups(user.groups);
      const groups = await enrichGroupKinds(client, membership);
      return {
        userName: user.userName ?? userName,
        displayName: user.displayName ?? null,
        userId: user.id ?? null,
        principalKind,
        groups,
      };
    }
    return {
      userName,
      displayName: null,
      userId: null,
      principalKind: 'unknown',
      groups: [],
    };
  }

  async listWorkspaceTags(
    req: IdentityRequest,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, string>> {
    const client = getOboWorkspaceClient(req);
    const response = await requestJson(client, {
      path: '/api/2.0/entity-tag-assignments',
      method: 'GET',
      query: { entity_type: entityType, entity_id: entityId },
    });
    const parsed = z
      .object({ tag_assignments: z.array(TagAssignment).optional() })
      .safeParse(response);
    const tags: Record<string, string> = {};
    for (const assignment of parsed.success ? (parsed.data.tag_assignments ?? []) : []) {
      tags[assignment.tag_key] = assignment.tag_value ?? '';
    }
    return tags;
  }

  async listUcTags(
    req: IdentityRequest,
    entityType: string,
    entityName: string,
  ): Promise<Record<string, string>> {
    const sql = ucTagSelectSql(entityType, entityName);
    const rows = await executeOboSql(req, sql);
    const tags: Record<string, string> = {};
    for (const [tagName, tagValue] of rows) {
      if (tagName) {
        tags[tagName] = tagValue ?? '';
      }
    }
    return tags;
  }
}

export function classifyOwnerPrincipal(userName: string): JobOwnerIdentity['principalKind'] {
  if (userName.includes('@')) {
    return 'user';
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userName)) {
    return 'service_principal';
  }
  return 'unknown';
}

export function mapUserGroups(
  groups: Array<{ display?: string; value?: string }> | undefined,
): IdentityGroup[] {
  const seen = new Set<string>();
  const mapped: IdentityGroup[] = [];
  for (const group of groups ?? []) {
    const displayName = group.display?.trim() || group.value?.trim();
    const id = group.value?.trim() || displayName;
    if (!displayName || !id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    mapped.push({ id, displayName, kind: 'unknown' });
  }
  return mapped.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function enrichGroupKinds(
  client: ReturnType<typeof getOboWorkspaceClient>,
  groups: IdentityGroup[],
): Promise<IdentityGroup[]> {
  const limited = groups.slice(0, 25);
  return Promise.all(
    limited.map(async (group) => {
      try {
        const detail = await client.groupsV2.get({ id: group.id });
        const resourceType = detail.meta?.resourceType;
        const kind =
          resourceType === 'WorkspaceGroup' ? 'workspace' : resourceType === 'Group' ? 'account' : group.kind;
        return {
          id: detail.id ?? group.id,
          displayName: detail.displayName ?? group.displayName,
          kind,
        };
      } catch {
        return group;
      }
    }),
  );
}

function ucTagSelectSql(entityType: string, entityName: string): string {
  const name = quoteSqlLiteral(entityName);
  if (entityType === 'catalogs') {
    return `SELECT tag_name, tag_value FROM system.information_schema.catalog_tags WHERE catalog_name = ${name}`;
  }
  if (entityType === 'schemas') {
    return `SELECT tag_name, tag_value FROM system.information_schema.schema_tags
            WHERE concat(catalog_name, '.', schema_name) = ${name}`;
  }
  if (entityType === 'volumes') {
    return `SELECT tag_name, tag_value FROM system.information_schema.volume_tags
            WHERE concat(catalog_name, '.', schema_name, '.', volume_name) = ${name}`;
  }
  if (entityType === 'columns') {
    return `SELECT tag_name, tag_value FROM system.information_schema.column_tags
            WHERE concat(catalog_name, '.', schema_name, '.', table_name, '.', column_name) = ${name}`;
  }
  return `SELECT tag_name, tag_value FROM system.information_schema.table_tags
          WHERE concat(catalog_name, '.', schema_name, '.', table_name) = ${name}`;
}

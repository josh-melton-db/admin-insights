import type { Application, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  FINDING_STATUSES,
  PRINCIPAL_TYPES,
  RESOURCE_TYPES,
  type Actor,
} from '../../shared/admin-insights';
import { AdminInsightsService } from './service';

const SubmitRequestSchema = z.object({
  requestedFor: z.string().trim().email().nullable().optional(),
  subjectPrincipalId: z.string().trim().min(1).max(200).nullable().optional(),
  subjectPrincipalType: z.enum(PRINCIPAL_TYPES),
  subjectDisplayName: z.string().trim().max(250).nullable().optional(),
  resourceType: z.enum(RESOURCE_TYPES),
  resourceName: z.string().trim().min(1).max(500),
  requestedPrivileges: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  justification: z.string().trim().min(8).max(4000),
  requestMode: z.enum(['self', 'on_behalf_of', 'service_principal']),
  idempotencyKey: z.string().trim().min(8).max(200).nullable().optional(),
});

const DecisionSchema = z.object({
  note: z.string().trim().max(4000).nullable().optional(),
});

const CreateFindingSchema = z.object({
  findingType: z.string().trim().min(1).max(100),
  targetType: z.enum(RESOURCE_TYPES),
  targetId: z.string().trim().min(1).max(500),
  targetName: z.string().trim().min(1).max(500),
  severity: z.enum(['low', 'medium', 'high']),
  summary: z.string().trim().min(8).max(4000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

const ProgressFindingSchema = z.object({
  status: z.enum(FINDING_STATUSES),
  note: z.string().trim().max(4000).nullable().optional(),
});

const UcTagSchema = z.object({
  entityType: z.enum(['catalogs', 'schemas', 'tables', 'columns', 'volumes']),
  entityName: z.string().trim().min(1).max(500),
  tagKey: z.string().trim().min(1).max(100),
  tagValue: z.string().trim().max(500),
  confirmed: z.boolean().optional(),
});

const WorkspaceTagSchema = z.object({
  entityType: z.enum(['apps', 'dashboards', 'geniespaces', 'notebooks']),
  entityId: z.string().trim().min(1).max(500),
  tagKey: z.string().trim().min(1).max(100),
  tagValue: z.string().trim().max(500),
  confirmed: z.boolean().optional(),
});

const JobTagsSchema = z.object({
  jobId: z.number().int().positive(),
  tags: z.record(z.string(), z.string().max(500)).refine((value) => Object.keys(value).length > 0, {
    message: 'At least one tag is required',
  }),
  confirmed: z.boolean().optional(),
});

const JobPolicySchema = z.object({
  jobId: z.number().int().positive(),
  policyId: z.string().trim().min(1).max(200),
  confirmed: z.boolean().optional(),
});

const AppPolicySchema = z.object({
  appName: z.string().trim().min(1).max(200),
  policyId: z.string().trim().min(1).max(200),
  confirmed: z.boolean().optional(),
});

const CreateBudgetPolicySchema = z.object({
  jobId: z.string().trim().min(1).max(100),
  jobName: z.string().trim().min(1).max(500),
  ownerUserName: z.string().trim().min(1).max(250),
  groupId: z.string().trim().min(1).max(200),
  groupDisplayName: z.string().trim().min(1).max(250),
  groupKind: z.enum(['account', 'workspace', 'unknown']),
  policyName: z.string().trim().min(3).max(128),
  customTags: z
    .record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(500))
    .refine((value) => Object.keys(value).length > 0, { message: 'At least one custom tag is required' }),
  confirmed: z.boolean().optional(),
});

const OwnerLookupSchema = z.object({
  userName: z.string().trim().min(1).max(250),
});

const GrantRoleSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['admin', 'requester', 'auditor']),
});

type ActorHandler = (req: Request, res: Response, actor: Actor) => Promise<void>;

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') {
    throw new Error(`Missing route parameter: ${name}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected server error';
}

function errorStatus(message: string): number {
  if (message.includes('proxy identity')) {
    return 401;
  }
  if (
    message.includes('Administrator role') ||
    message.includes('Requester role') ||
    message.includes('Auditor role') ||
    message.includes('Self-approval')
  ) {
    return 403;
  }
  if (message.includes('was not found')) {
    return 404;
  }
  if (message.includes('no longer') || message.includes('already')) {
    return 409;
  }
  return 400;
}

function route(service: AdminInsightsService, handler: ActorHandler): RequestHandler {
  return (req, res) => {
    void (async () => {
      try {
        const actor = await service.actorForRequest(req);
        await handler(req, res, actor);
      } catch (error) {
        const message = errorMessage(error);
        res.status(errorStatus(message)).json({ error: message });
      }
    })();
  };
}

function bodyError(res: Response, details: z.ZodError): void {
  res.status(400).json({
    error: 'Invalid request body',
    details: details.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

export function registerAdminInsightsRoutes(app: Application, service: AdminInsightsService): void {
  app.get(
    '/api/admin/whoami',
    route(service, (_req, res, actor) => {
      res.json({ actor, runtime: service.getRuntimeConfiguration() });
      return Promise.resolve();
    }),
  );

  app.get(
    '/api/admin/summary',
    route(service, async (_req, res, actor) => {
      res.json(await service.getSummary(actor));
    }),
  );

  app.get(
    '/api/admin/requests',
    route(service, async (_req, res, actor) => {
      res.json(await service.listRequests(actor));
    }),
  );

  app.post(
    '/api/admin/requests',
    route(service, async (req, res, actor) => {
      const parsed = SubmitRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      const created = await service.submitRequest(actor, parsed.data);
      res.status(201).json(created);
    }),
  );

  app.post(
    '/api/admin/requests/:id/approve',
    route(service, async (req, res, actor) => {
      const parsed = DecisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.decideRequest(actor, routeParam(req, 'id'), 'approved', parsed.data.note ?? null));
    }),
  );

  app.post(
    '/api/admin/requests/:id/deny',
    route(service, async (req, res, actor) => {
      const parsed = DecisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.decideRequest(actor, routeParam(req, 'id'), 'denied', parsed.data.note ?? null));
    }),
  );

  app.get(
    '/api/admin/findings',
    route(service, async (_req, res, actor) => {
      res.json(await service.listFindings(actor));
    }),
  );

  app.post(
    '/api/admin/findings',
    route(service, async (req, res, actor) => {
      const parsed = CreateFindingSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.status(201).json(await service.createFinding(actor, parsed.data));
    }),
  );

  app.post(
    '/api/admin/findings/:id/status',
    route(service, async (req, res, actor) => {
      const parsed = ProgressFindingSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(
        await service.progressFinding(actor, routeParam(req, 'id'), parsed.data.status, parsed.data.note ?? null),
      );
    }),
  );

  app.get(
    '/api/admin/audit',
    route(service, async (_req, res, actor) => {
      res.json(await service.listAudit(actor));
    }),
  );

  app.get(
    '/api/admin/inventory/jobs',
    route(service, async (req, res, actor) => {
      res.json(await service.listJobs(req, actor));
    }),
  );

  app.get(
    '/api/admin/inventory/apps',
    route(service, async (req, res, actor) => {
      res.json(await service.listApps(req, actor));
    }),
  );

  app.get(
    '/api/admin/inventory/serving-endpoints',
    route(service, async (req, res, actor) => {
      res.json(await service.listServingEndpoints(req, actor));
    }),
  );

  app.get(
    '/api/admin/policies',
    route(service, async (req, res, actor) => {
      res.json(await service.listPolicies(req, actor));
    }),
  );

  app.get(
    '/api/admin/identities/groups',
    route(service, async (req, res, actor) => {
      const parsed = OwnerLookupSchema.safeParse({
        userName: typeof req.query.userName === 'string' ? req.query.userName : '',
      });
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.listJobOwnerIdentity(req, actor, parsed.data.userName));
    }),
  );

  app.post(
    '/api/admin/actions/uc-tag/preview',
    route(service, async (req, res, actor) => {
      const parsed = UcTagSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.previewUcTag(req, actor, parsed.data));
    }),
  );

  app.post(
    '/api/admin/actions/uc-tag',
    route(service, async (req, res, actor) => {
      const parsed = UcTagSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(
        await service.applyMutation(req, actor, { type: 'uc_tag', input: parsed.data }, parsed.data.confirmed === true),
      );
    }),
  );

  app.post(
    '/api/admin/actions/workspace-tag/preview',
    route(service, async (req, res, actor) => {
      const parsed = WorkspaceTagSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.previewWorkspaceTag(req, actor, parsed.data));
    }),
  );

  app.post(
    '/api/admin/actions/workspace-tag',
    route(service, async (req, res, actor) => {
      const parsed = WorkspaceTagSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(
        await service.applyMutation(
          req,
          actor,
          { type: 'workspace_tag', input: parsed.data },
          parsed.data.confirmed === true,
        ),
      );
    }),
  );

  app.post(
    '/api/admin/actions/job-tags/preview',
    route(service, async (req, res, actor) => {
      const parsed = JobTagsSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.previewJobTags(req, actor, parsed.data));
    }),
  );

  app.post(
    '/api/admin/actions/job-tags',
    route(service, async (req, res, actor) => {
      const parsed = JobTagsSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(
        await service.applyMutation(req, actor, { type: 'job_tags', input: parsed.data }, parsed.data.confirmed === true),
      );
    }),
  );

  app.post(
    '/api/admin/actions/job-policy/preview',
    route(service, async (req, res, actor) => {
      const parsed = JobPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.previewJobPolicy(req, actor, parsed.data));
    }),
  );

  app.post(
    '/api/admin/actions/job-policy',
    route(service, async (req, res, actor) => {
      const parsed = JobPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(
        await service.applyMutation(
          req,
          actor,
          { type: 'job_policy', input: parsed.data },
          parsed.data.confirmed === true,
        ),
      );
    }),
  );

  app.post(
    '/api/admin/actions/app-policy/preview',
    route(service, async (req, res, actor) => {
      const parsed = AppPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.previewAppPolicy(req, actor, parsed.data));
    }),
  );

  app.post(
    '/api/admin/actions/app-policy',
    route(service, async (req, res, actor) => {
      const parsed = AppPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(
        await service.applyMutation(
          req,
          actor,
          { type: 'app_policy', input: parsed.data },
          parsed.data.confirmed === true,
        ),
      );
    }),
  );

  app.post(
    '/api/admin/actions/budget-policy/preview',
    route(service, async (req, res, actor) => {
      const parsed = CreateBudgetPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(await service.previewCreateBudgetPolicy(req, actor, parsed.data));
    }),
  );

  app.post(
    '/api/admin/actions/budget-policy',
    route(service, async (req, res, actor) => {
      const parsed = CreateBudgetPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      res.json(
        await service.applyMutation(
          req,
          actor,
          { type: 'create_budget_policy', input: parsed.data },
          parsed.data.confirmed === true,
        ),
      );
    }),
  );

  app.post(
    '/api/admin/roles',
    route(service, async (req, res, actor) => {
      const parsed = GrantRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        bodyError(res, parsed.error);
        return;
      }
      await service.grantRole(actor, parsed.data.email, parsed.data.role);
      res.status(204).end();
    }),
  );
}

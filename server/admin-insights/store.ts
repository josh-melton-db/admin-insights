import { randomUUID } from 'node:crypto';
import type {
  AccessRequest,
  Actor,
  AuditEvent,
  Finding,
  FindingStatus,
  FindingStatusHistory,
  PrincipalType,
  RequestStatus,
  ResourceType,
} from '../../shared/admin-insights';
import type { LakebaseQuery } from './migrations';

function dateValue(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed));
    }
    return {};
  } catch {
    return {};
  }
}

interface AccessRequestRow {
  id: string;
  requested_by: string;
  requested_for: string;
  subject_principal_id: string;
  subject_principal_type: PrincipalType;
  subject_display_name: string;
  resource_type: ResourceType;
  resource_name: string;
  requested_privileges: unknown;
  justification: string;
  request_mode: AccessRequest['requestMode'];
  status: RequestStatus;
  decision_note: string | null;
  approver: string | null;
  decided_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FindingRow {
  id: string;
  finding_type: string;
  target_type: ResourceType;
  target_id: string;
  target_name: string;
  severity: Finding['severity'];
  status: FindingStatus;
  summary: string;
  evidence: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HistoryRow {
  id: string;
  finding_id: string;
  actor: string;
  from_status: FindingStatus | null;
  to_status: FindingStatus;
  note: string | null;
  created_at: Date | string;
}

interface AuditRow {
  id: string;
  request_id: string | null;
  finding_id: string | null;
  actor: string;
  action: string;
  outcome: AuditEvent['outcome'];
  message: string | null;
  payload: unknown;
  created_at: Date | string;
}

function mapRequest(row: AccessRequestRow): AccessRequest {
  return {
    id: row.id,
    requestedBy: row.requested_by,
    requestedFor: row.requested_for,
    subjectPrincipalId: row.subject_principal_id,
    subjectPrincipalType: row.subject_principal_type,
    subjectDisplayName: row.subject_display_name,
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    requestedPrivileges: jsonArray(row.requested_privileges),
    justification: row.justification,
    requestMode: row.request_mode,
    status: row.status,
    decisionNote: row.decision_note,
    approver: row.approver,
    decidedAt: dateValue(row.decided_at),
    createdAt: dateValue(row.created_at) ?? '',
    updatedAt: dateValue(row.updated_at) ?? '',
  };
}

function mapFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    findingType: row.finding_type,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    evidence: jsonObject(row.evidence),
    createdBy: row.created_by,
    createdAt: dateValue(row.created_at) ?? '',
    updatedAt: dateValue(row.updated_at) ?? '',
  };
}

function mapHistory(row: HistoryRow): FindingStatusHistory {
  return {
    id: row.id,
    findingId: row.finding_id,
    actor: row.actor,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    createdAt: dateValue(row.created_at) ?? '',
  };
}

function mapEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    requestId: row.request_id,
    findingId: row.finding_id,
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    message: row.message,
    payload: jsonObject(row.payload),
    createdAt: dateValue(row.created_at) ?? '',
  };
}

export class AdminInsightsStore {
  public constructor(private readonly db: LakebaseQuery) {}

  async getRoles(email: string): Promise<string[]> {
    const result = await this.db.query<{ role: string }>(
      `SELECT role FROM admin_app.app_roles WHERE principal_email = $1`,
      [email],
    );
    return result.rows.map((row) => row.role);
  }

  async grantRole(email: string, role: 'admin' | 'requester' | 'auditor', assignedBy: string): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_app.app_roles (principal_email, role, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (principal_email, role) DO NOTHING`,
      [email.toLowerCase(), role, assignedBy],
    );
  }

  async createAccessRequest(input: {
    requestedBy: string;
    requestedFor: string;
    subjectPrincipalId: string;
    subjectPrincipalType: PrincipalType;
    subjectDisplayName: string;
    resourceType: ResourceType;
    resourceName: string;
    requestedPrivileges: string[];
    justification: string;
    requestMode: AccessRequest['requestMode'];
    idempotencyKey: string | null;
  }): Promise<AccessRequest> {
    if (input.idempotencyKey) {
      const existing = await this.db.query<AccessRequestRow>(
        `SELECT * FROM admin_app.access_requests
         WHERE requested_by = $1 AND idempotency_key = $2`,
        [input.requestedBy, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return mapRequest(existing.rows[0]);
      }
    }

    const id = randomUUID();
    const result = await this.db.query<AccessRequestRow>(
      `INSERT INTO admin_app.access_requests (
        id, requested_by, requested_for, subject_principal_id, subject_principal_type,
        subject_display_name, resource_type, resource_name, requested_privileges,
        justification, request_mode, status, idempotency_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'submitted',$12)
      RETURNING *`,
      [
        id,
        input.requestedBy,
        input.requestedFor,
        input.subjectPrincipalId,
        input.subjectPrincipalType,
        input.subjectDisplayName,
        input.resourceType,
        input.resourceName,
        JSON.stringify(input.requestedPrivileges),
        input.justification,
        input.requestMode,
        input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create access request');
    }
    return mapRequest(row);
  }

  async listAccessRequests(actor: Actor): Promise<AccessRequest[]> {
    const result = actor.isAdmin
      ? await this.db.query<AccessRequestRow>(
          `SELECT * FROM admin_app.access_requests ORDER BY created_at DESC LIMIT 200`,
        )
      : await this.db.query<AccessRequestRow>(
          `SELECT * FROM admin_app.access_requests
           WHERE requested_by = $1 OR requested_for = $1
           ORDER BY created_at DESC LIMIT 200`,
          [actor.email],
        );
    return result.rows.map(mapRequest);
  }

  async getAccessRequest(id: string): Promise<AccessRequest | null> {
    const result = await this.db.query<AccessRequestRow>(
      `SELECT * FROM admin_app.access_requests WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRequest(result.rows[0]) : null;
  }

  async transitionRequest(
    id: string,
    fromStatus: RequestStatus,
    toStatus: RequestStatus,
    fields: { approver?: string; decisionNote?: string | null } = {},
  ): Promise<AccessRequest> {
    const result = await this.db.query<AccessRequestRow>(
      `UPDATE admin_app.access_requests
       SET status = $3,
           approver = COALESCE($4, approver),
           decision_note = COALESCE($5, decision_note),
           decided_at = CASE WHEN $3 IN ('approved', 'denied', 'completed', 'failed') THEN NOW() ELSE decided_at END,
           updated_at = NOW()
       WHERE id = $1 AND status = $2
       RETURNING *`,
      [id, fromStatus, toStatus, fields.approver ?? null, fields.decisionNote ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Access request is no longer in the expected state');
    }
    return mapRequest(row);
  }

  async createFinding(input: {
    findingType: string;
    targetType: ResourceType;
    targetId: string;
    targetName: string;
    severity: Finding['severity'];
    summary: string;
    evidence: Record<string, unknown>;
    createdBy: string;
  }): Promise<Finding> {
    const id = randomUUID();
    const result = await this.db.query<FindingRow>(
      `INSERT INTO admin_app.findings (
        id, finding_type, target_type, target_id, target_name, severity, status, summary, evidence, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8::jsonb,$9)
      RETURNING *`,
      [
        id,
        input.findingType,
        input.targetType,
        input.targetId,
        input.targetName,
        input.severity,
        input.summary,
        JSON.stringify(input.evidence),
        input.createdBy,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create finding');
    }
    await this.addFindingHistory({
      findingId: id,
      actor: input.createdBy,
      fromStatus: null,
      toStatus: 'open',
      note: 'Finding recorded',
    });
    return mapFinding(row);
  }

  async listFindings(): Promise<Finding[]> {
    const result = await this.db.query<FindingRow>(
      `SELECT * FROM admin_app.findings ORDER BY created_at DESC LIMIT 200`,
    );
    return result.rows.map(mapFinding);
  }

  async getFinding(id: string): Promise<Finding | null> {
    const result = await this.db.query<FindingRow>(`SELECT * FROM admin_app.findings WHERE id = $1`, [id]);
    return result.rows[0] ? mapFinding(result.rows[0]) : null;
  }

  async updateFindingStatus(
    id: string,
    fromStatus: FindingStatus,
    toStatus: FindingStatus,
    actor: string,
    note: string | null,
  ): Promise<Finding> {
    const result = await this.db.query<FindingRow>(
      `UPDATE admin_app.findings
       SET status = $3, updated_at = NOW()
       WHERE id = $1 AND status = $2
       RETURNING *`,
      [id, fromStatus, toStatus],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Finding is no longer in the expected state');
    }
    await this.addFindingHistory({
      findingId: id,
      actor,
      fromStatus,
      toStatus,
      note,
    });
    return mapFinding(row);
  }

  async addFindingHistory(input: {
    findingId: string;
    actor: string;
    fromStatus: FindingStatus | null;
    toStatus: FindingStatus;
    note: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_app.finding_status_history
        (id, finding_id, actor, from_status, to_status, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), input.findingId, input.actor, input.fromStatus, input.toStatus, input.note],
    );
  }

  async listFindingHistory(findingId: string): Promise<FindingStatusHistory[]> {
    const result = await this.db.query<HistoryRow>(
      `SELECT * FROM admin_app.finding_status_history
       WHERE finding_id = $1
       ORDER BY created_at DESC`,
      [findingId],
    );
    return result.rows.map(mapHistory);
  }

  async writeAuditEvent(event: Omit<AuditEvent, 'createdAt'>): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_app.audit_events
        (id, request_id, finding_id, actor, action, outcome, message, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        event.id,
        event.requestId,
        event.findingId,
        event.actor,
        event.action,
        event.outcome,
        event.message,
        JSON.stringify(event.payload),
      ],
    );
  }

  async listAuditEvents(limit: number): Promise<AuditEvent[]> {
    const result = await this.db.query<AuditRow>(
      `SELECT * FROM admin_app.audit_events ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapEvent);
  }

  async countOpenFindings(): Promise<number> {
    const result = await this.db.query<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM admin_app.findings WHERE status IN ('open', 'acknowledged', 'in_progress')`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countPendingRequests(): Promise<number> {
    const result = await this.db.query<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM admin_app.access_requests WHERE status = 'submitted'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countRecentAuditEvents(): Promise<number> {
    const result = await this.db.query<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM admin_app.audit_events WHERE created_at >= NOW() - INTERVAL '7 days'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

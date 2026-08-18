export interface LakebaseQuery {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export function asLakebaseQuery(lakebase: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}): LakebaseQuery {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await lakebase.query(text, params);
      return { rows: result.rows as T[] };
    },
  };
}

const MIGRATIONS = [
  `CREATE SCHEMA IF NOT EXISTS admin_app`,
  `CREATE TABLE IF NOT EXISTS admin_app.app_roles (
    principal_email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'requester', 'auditor')),
    assigned_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (principal_email, role)
  )`,
  `CREATE TABLE IF NOT EXISTS admin_app.access_requests (
    id TEXT PRIMARY KEY,
    requested_by TEXT NOT NULL,
    requested_for TEXT NOT NULL,
    subject_principal_id TEXT NOT NULL,
    subject_principal_type TEXT NOT NULL CHECK (subject_principal_type IN ('user', 'service_principal')),
    subject_display_name TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    requested_privileges JSONB NOT NULL DEFAULT '[]'::jsonb,
    justification TEXT NOT NULL,
    request_mode TEXT NOT NULL CHECK (request_mode IN ('self', 'on_behalf_of', 'service_principal')),
    status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'denied', 'in_progress', 'completed', 'failed')),
    decision_note TEXT,
    approver TEXT,
    decided_at TIMESTAMPTZ,
    idempotency_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS access_requests_idempotency_key_idx
    ON admin_app.access_requests (requested_by, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS access_requests_status_created_idx
    ON admin_app.access_requests (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS admin_app.findings (
    id TEXT PRIMARY KEY,
    finding_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_name TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'dismissed')),
    summary TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS findings_status_created_idx
    ON admin_app.findings (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS admin_app.finding_status_history (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES admin_app.findings(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS admin_app.audit_events (
    id TEXT PRIMARY KEY,
    request_id TEXT REFERENCES admin_app.access_requests(id) ON DELETE SET NULL,
    finding_id TEXT REFERENCES admin_app.findings(id) ON DELETE SET NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'info')),
    message TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_created_idx
    ON admin_app.audit_events (created_at DESC)`,
];

export async function runMigrations(lakebase: LakebaseQuery): Promise<void> {
  for (const statement of MIGRATIONS) {
    await lakebase.query(statement);
  }
}

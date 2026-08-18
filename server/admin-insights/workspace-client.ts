import { AccountClient, WorkspaceClient } from '@databricks/sdk-experimental';
import type { IdentityRequest } from './identity';

export function getOboWorkspaceClient(req: IdentityRequest): WorkspaceClient {
  const token = req.get('x-forwarded-access-token');
  const host = process.env.DATABRICKS_HOST;
  if (token && host) {
    return new WorkspaceClient({ host, token, authType: 'pat' });
  }
  if (process.env.NODE_ENV === 'development') {
    return new WorkspaceClient(host ? { host } : {});
  }
  throw new Error('A trusted Databricks proxy identity header is required');
}

export function getOboAccountClient(req: IdentityRequest): AccountClient | null {
  const token = req.get('x-forwarded-access-token');
  const host = process.env.DATABRICKS_ACCOUNT_HOST;
  const accountId = process.env.DATABRICKS_ACCOUNT_ID;
  if (!token || !host || !accountId) {
    return null;
  }
  return new AccountClient({ host, accountId, token, authType: 'pat' });
}

export async function requestJson(
  client: WorkspaceClient,
  options: {
    path: string;
    method: 'GET' | 'POST' | 'PATCH' | 'PUT';
    query?: Record<string, string | number | boolean | undefined>;
    payload?: Record<string, unknown>;
  },
): Promise<unknown> {
  return client.apiClient.request({
    path: options.path,
    method: options.method,
    query: options.query,
    headers: new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    raw: false,
    payload: options.payload,
  });
}

export function quoteSqlIdent(name: string): string {
  return name
    .split('.')
    .filter(Boolean)
    .map((part) => `\`${part.replace(/`/g, '')}\``)
    .join('.');
}

export function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface SqlStatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  result?: { data_array?: string[][] };
}

export async function executeOboSql(req: IdentityRequest, statement: string): Promise<string[][]> {
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) {
    throw new Error('DATABRICKS_WAREHOUSE_ID is required for Unity Catalog SQL actions');
  }
  const client = getOboWorkspaceClient(req);
  const started = (await requestJson(client, {
    path: '/api/2.0/sql/statements',
    method: 'POST',
    payload: {
      warehouse_id: warehouseId,
      statement,
      wait_timeout: '30s',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    },
  })) as SqlStatementResponse;

  let current = started;
  for (let attempt = 0; attempt < 10 && current.status?.state === 'PENDING' && current.statement_id; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = (await requestJson(client, {
      path: `/api/2.0/sql/statements/${current.statement_id}`,
      method: 'GET',
    })) as SqlStatementResponse;
  }

  if (current.status?.state !== 'SUCCEEDED') {
    throw new Error(current.status?.error?.message ?? 'Unity Catalog SQL statement did not succeed');
  }
  return current.result?.data_array ?? [];
}

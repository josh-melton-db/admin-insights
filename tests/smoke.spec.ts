import { expect, test } from '@playwright/test';

const adminIdentity = {
  actor: {
    email: 'admin@example.com',
    displayName: 'Example Admin',
    roles: ['admin'],
    isAdmin: true,
    isRequester: true,
    isAuditor: true,
  },
  runtime: {
    executionMode: 'dry_run',
    allowedActions: [
      'set_uc_tag',
      'set_workspace_tag',
      'set_job_tags',
      'assign_job_policy',
      'assign_app_policy',
      'create_budget_policy',
    ],
    workspaceHost: 'https://example.cloud.databricks.com',
  },
};

const restrictedIdentity = {
  ...adminIdentity,
  actor: {
    email: 'requester@example.com',
    displayName: 'Requester',
    roles: ['requester'],
    isAdmin: false,
    isRequester: true,
    isAuditor: false,
  },
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/whoami', (route) => route.fulfill({ json: adminIdentity }));
  await page.route('**/api/admin/summary', (route) =>
    route.fulfill({
      json: {
        openFindings: 0,
        pendingRequests: 0,
        recentAuditEvents: 0,
        executionMode: 'dry_run',
        asOf: '2026-08-17T00:00:00.000Z',
      },
    }),
  );
  await page.route('**/api/admin/requests', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/findings', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/audit', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/inventory/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/policies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/analytics/query/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"result","data":[]}\n\n',
    }),
  );
});

test('overview loads KPI states, filters, and readiness', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Admin Insights', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Admin Insights overview' })).toBeVisible();
  await expect(page.getByText('execution dry_run')).toBeVisible();
  await expect(page.getByLabel('Start date')).toBeVisible();
  await expect(page.getByLabel('Workspace scope')).toBeVisible();
  await expect(page.getByText('System-table readiness', { exact: true })).toBeVisible();
  await expect(page.getByText('Missing grants to apply', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Data governance' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Resource hygiene' })).toBeVisible();
  await expect(page.getByText('Active users', { exact: true })).toBeVisible();
  await expect(page.getByText('Tables managed', { exact: true })).toBeVisible();
  await expect(page.getByText('Genie: conversations versus Databricks-funded usage', { exact: true })).toBeVisible();
  await expect(page.getByText('Each user gets 150 free Genie Code DBUs per month')).toBeVisible();
});

test('governance records access requests and previews tag mutations', async ({ page }) => {
  await page.route('**/api/analytics/query/lineage_ingestion', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"result","data":[{"source_type":"TABLE","target_type":"METRIC_VIEW","source_table_catalog":"demos","target_table_catalog":"demos","lineage_events":12,"distinct_sources":4,"distinct_targets":2}]}\n\n',
    }),
  );
  await page.route('**/api/analytics/query/lineage_connections', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"result","data":[{"source_type":"TABLE","target_type":"METRIC_VIEW","source_name":"demos.gold.orders","target_name":"demos.gold.orders_metrics","source_table_catalog":"demos","target_table_catalog":"demos","lineage_events":8,"last_event_time":"2026-08-18T00:00:00.000Z"}]}\n\n',
    }),
  );

  await page.goto('/governance');

  await expect(page.getByRole('heading', { name: 'Data governance and object explorer' })).toBeVisible();
  await expect(page.getByText('Click a catalog to open its schemas', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Filter lineage type pairs')).toBeVisible();
  await page.getByRole('button', { name: 'TABLE → METRIC_VIEW' }).click();
  await expect(page.getByLabel('Filter lineage connections')).toBeVisible();
  await expect(page.getByText('demos.gold.orders_metrics')).toBeVisible();
  await page.getByRole('button', { name: 'Type pairs' }).click();
  await expect(page.getByLabel('Filter lineage type pairs')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview tag update' })).toBeVisible();
  await page.getByRole('tab', { name: 'Privileges' }).click();
  await expect(page.getByLabel('Resource catalog')).toBeVisible();
  await expect(page.getByLabel('Principal type')).toBeVisible();
  await expect(page.getByLabel('Grantee')).toBeVisible();
  await expect(page.getByLabel('Class', { exact: true })).toBeVisible();
  await expect(page.getByText('Grants by principal type', { exact: true })).toBeVisible();
  await expect(page.getByText('Top principals by grants', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Tags' }).click();
  await expect(page.getByText('Governed tags', { exact: true })).toBeVisible();
  await expect(page.getByText('Popular tables missing tags', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Access requests' }).click();
  await expect(page.getByText('Lakebase access requests', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New access request' })).toBeVisible();
});

test('hygiene shows safe-action confirmation controls for admins', async ({ page }) => {
  await page.route('**/api/analytics/query/hygiene_untagged_job_creators', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"result","data":[{"workspace_id":"123","creator_user_name":"owner@example.com","job_count":1,"paused_job_count":0,"last_run_time":null}]}\n\n',
    }),
  );
  await page.route('**/api/analytics/query/hygiene_untagged_jobs', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"result","data":[{"workspace_id":"123","job_id":"99","name":"untagged-etl","creator_user_name":"owner@example.com","create_time":"2026-08-01T00:00:00.000Z","paused":false,"tag_count":0,"last_run_time":null}]}\n\n',
    }),
  );
  await page.route('**/api/admin/identities/groups**', (route) =>
    route.fulfill({
      json: {
        userName: 'owner@example.com',
        displayName: 'Owner Example',
        userId: '1',
        principalKind: 'user',
        groups: [
          { id: '42', displayName: 'data-eng', kind: 'account' },
          { id: '7', displayName: 'local-ops', kind: 'workspace' },
        ],
      },
    }),
  );

  await page.goto('/hygiene');

  await expect(page.getByRole('heading', { name: 'Resource hygiene' })).toBeVisible();
  await expect(page.getByText('Tables produced with no reads', { exact: true })).toBeVisible();
  await expect(page.getByText('Safe actions', { exact: true })).toBeVisible();
  await expect(page.getByText('Jobs and Apps APIs are outside this app OBO scopes', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Idle serving scale to zero')).toBeVisible();
  await expect(page.getByLabel('Billed serving scale to zero')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview job tag update' })).toBeVisible();

  await expect(page.getByLabel('Filter creators')).toBeVisible();
  await page.getByRole('button', { name: 'owner@example.com' }).click();
  await expect(page.getByLabel('Filter jobs')).toBeVisible();
  await expect(page.getByLabel('Job paused')).toBeVisible();
  await page.getByRole('button', { name: 'untagged-etl' }).click();
  await expect(page.getByRole('heading', { name: 'Owner groups and serverless usage policy' })).toBeVisible();
  await expect(page.getByText('data-eng')).toBeVisible();
  await expect(page.getByText('Workspace-local — cannot receive this policy')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview policy for group' })).toBeVisible();
});

test('restricted users do not receive mutation controls', async ({ page }) => {
  await page.unroute('**/api/admin/whoami');
  await page.route('**/api/admin/whoami', (route) => route.fulfill({ json: restrictedIdentity }));

  await page.goto('/hygiene');
  await expect(page.getByText('Administrator role required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview job tag update' })).toHaveCount(0);
});

test('ROI screens render and cancel analytics streams on navigation', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(message.text());
    }
  });

  await page.goto('/cost');
  await expect(page.getByRole('heading', { name: 'Return on spend' })).toBeVisible();
  await expect(page.getByText('Highest-spend resources', { exact: true })).toBeVisible();
  await expect(page.getByText('Serving with queries', { exact: true })).toBeVisible();
  await expect(page.getByText('Vector Search index queries', { exact: true })).toBeVisible();
  await expect(page.getByText('Knowledge assistants', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Filter serving with queries')).toBeVisible();
  await expect(page.getByLabel('Filter vector indexes')).toBeVisible();
  await expect(page.getByLabel('Filter knowledge assistants')).toBeVisible();
  await expect(page.getByLabel('Knowledge assistant questions')).toBeVisible();
  await expect(page.getByText('Tagged spend share', { exact: true })).toBeVisible();
  await expect(page.getByText('Spend by tag', { exact: true })).toBeVisible();
  await expect(page.getByText('Active models', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Idle serving scale to zero')).toBeVisible();
  await expect(page.getByLabel('Active models scale to zero')).toBeVisible();
  await expect(page.getByText('Active serving requesters', { exact: true })).toBeVisible();
  await expect(page.getByText('High-ROI jobs', { exact: true })).toBeVisible();
  await expect(page.getByText('Wasted spend over time', { exact: true })).toBeVisible();
  await expect(page.getByText('Most consumed tables', { exact: true })).toBeVisible();
  await expect(page.getByText('Databricks-funded Genie usage', { exact: true })).toBeVisible();
  await expect(page.getByText('150 DBUs of Genie Code free')).toBeVisible();
  await expect(page.getByText('Genie conversations (return)', { exact: true })).toBeVisible();
  await expect(page.getByText('Genie investment (free vs billed)', { exact: true })).toBeVisible();
  await expect(page.getByText('AI Gateway rate limits', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Compute' }).click();
  await expect(page.getByText('Jobs on interactive compute', { exact: true })).toBeVisible();
  await expect(page.getByText('Underutilized clusters', { exact: true })).toBeVisible();
  await expect(page.getByText('SQL warehouse sizing', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Admin Insights overview' })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

import { describe, expect, it } from 'vitest';
import {
  appDetailsUrl,
  catalogExplorerUrl,
  clusterUrl,
  genieSpaceUrl,
  jobUrl,
  normalizeWorkspaceHost,
  parseTableFullName,
  schemaExplorerUrl,
  tableUrlFromFullName,
  workspaceResourceUrl,
} from './workspace-links';

describe('workspace links', () => {
  const host = 'fe-example.cloud.databricks.com';

  it('normalizes hosts without a scheme', () => {
    expect(normalizeWorkspaceHost(host)).toBe('https://fe-example.cloud.databricks.com');
    expect(normalizeWorkspaceHost('https://fe-example.cloud.databricks.com/')).toBe(
      'https://fe-example.cloud.databricks.com',
    );
  });

  it('builds job, app, and table URLs', () => {
    expect(jobUrl(host, 123)).toBe('https://fe-example.cloud.databricks.com/jobs/123');
    expect(appDetailsUrl(host, 'admin-insights')).toBe(
      'https://fe-example.cloud.databricks.com/apps-v2/app/admin-insights/insights',
    );
    expect(appDetailsUrl(host, 'logistics-control-center', '860013386775689')).toBe(
      'https://fe-example.cloud.databricks.com/apps-v2/app/logistics-control-center/insights?o=860013386775689',
    );
    expect(workspaceResourceUrl(host, 'app', 'logistics-control-center', '860013386775689')).toBe(
      'https://fe-example.cloud.databricks.com/apps-v2/app/logistics-control-center/insights?o=860013386775689',
    );
    expect(parseTableFullName('demos.admin_insights.facts')).toEqual({
      catalog: 'demos',
      schema: 'admin_insights',
      table: 'facts',
    });
    expect(catalogExplorerUrl(host, 'demos')).toBe(
      'https://fe-example.cloud.databricks.com/explore/data/demos',
    );
    expect(schemaExplorerUrl(host, 'demos', 'admin_insights')).toBe(
      'https://fe-example.cloud.databricks.com/explore/data/demos/admin_insights',
    );
    expect(tableUrlFromFullName(host, 'demos.admin_insights.facts')).toBe(
      'https://fe-example.cloud.databricks.com/explore/data/demos/admin_insights/facts',
    );
    expect(genieSpaceUrl(host, '01f197ea720314d69ca96ed152d44b8e', '860013386775689')).toBe(
      'https://fe-example.cloud.databricks.com/genie/rooms/01f197ea720314d69ca96ed152d44b8e?o=860013386775689',
    );
    expect(workspaceResourceUrl(host, 'genie_space', '01f197ea720314d69ca96ed152d44b8e', '860013386775689')).toBe(
      'https://fe-example.cloud.databricks.com/genie/rooms/01f197ea720314d69ca96ed152d44b8e?o=860013386775689',
    );
    expect(genieSpaceUrl(host, 'abc-space')).toBe(
      'https://fe-example.cloud.databricks.com/genie/rooms/abc-space',
    );
    expect(genieSpaceUrl(host, 'unknown')).toBeNull();
    expect(clusterUrl(host, '0818-160004-t0zdz40h')).toBe(
      'https://fe-example.cloud.databricks.com/compute/clusters/0818-160004-t0zdz40h',
    );
    expect(workspaceResourceUrl(host, 'cluster', '0818-160004-t0zdz40h')).toBe(
      'https://fe-example.cloud.databricks.com/compute/clusters/0818-160004-t0zdz40h',
    );
  });

  it('returns null when the host or id is missing', () => {
    expect(jobUrl(null, 1)).toBeNull();
    expect(workspaceResourceUrl(host, 'sku', 'JOBS_COMPUTE')).toBeNull();
  });
});

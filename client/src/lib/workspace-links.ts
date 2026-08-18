export function normalizeWorkspaceHost(host: string | null | undefined): string | null {
  if (!host) {
    return null;
  }
  const trimmed = host.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function resourcePath(host: string | null | undefined, path: string): string | null {
  const base = normalizeWorkspaceHost(host);
  if (!base) {
    return null;
  }
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function jobUrl(host: string | null | undefined, jobId: string | number | null | undefined): string | null {
  if (jobId === null || jobId === undefined || jobId === '') {
    return null;
  }
  return resourcePath(host, `/jobs/${encodeURIComponent(String(jobId))}`);
}

export function servingEndpointUrl(
  host: string | null | undefined,
  endpointName: string | null | undefined,
): string | null {
  if (!endpointName) {
    return null;
  }
  return resourcePath(host, `/ml/endpoints/${encodeURIComponent(endpointName)}`);
}

export function appDetailsUrl(
  host: string | null | undefined,
  appName: string | null | undefined,
  workspaceId?: string | number | null,
): string | null {
  if (!appName) {
    return null;
  }
  const path = `/apps-v2/app/${encodeURIComponent(appName)}/insights`;
  const org = workspaceId == null || workspaceId === '' ? '' : String(workspaceId);
  if (!org || org === '0') {
    return resourcePath(host, path);
  }
  const base = resourcePath(host, path);
  return base ? `${base}?o=${encodeURIComponent(org)}` : null;
}

export function warehouseUrl(
  host: string | null | undefined,
  warehouseId: string | null | undefined,
): string | null {
  if (!warehouseId) {
    return null;
  }
  return resourcePath(host, `/sql/warehouses/${encodeURIComponent(warehouseId)}`);
}

export function clusterUrl(
  host: string | null | undefined,
  clusterId: string | null | undefined,
): string | null {
  if (!clusterId) {
    return null;
  }
  return resourcePath(host, `/compute/clusters/${encodeURIComponent(clusterId)}`);
}

export function pipelineUrl(
  host: string | null | undefined,
  pipelineId: string | null | undefined,
): string | null {
  if (!pipelineId) {
    return null;
  }
  return resourcePath(host, `/pipelines/${encodeURIComponent(pipelineId)}`);
}

export function vectorSearchUrl(
  host: string | null | undefined,
  endpointName?: string | null,
): string | null {
  if (endpointName) {
    return resourcePath(host, `/ml/vector-search/${encodeURIComponent(endpointName)}`);
  }
  return resourcePath(host, '/ml/vector-search');
}

export function knowledgeAssistantUrl(
  host: string | null | undefined,
  agentId: string | null | undefined,
): string | null {
  if (!agentId) {
    return null;
  }
  return servingEndpointUrl(host, `ka-${agentId.replace(/-/g, '').slice(0, 8)}-endpoint`);
}

export function genieSpaceUrl(
  host: string | null | undefined,
  spaceId: string | null | undefined,
  workspaceId?: string | number | null,
): string | null {
  if (!spaceId || spaceId === 'unknown') {
    return null;
  }
  const path = `/genie/rooms/${encodeURIComponent(spaceId)}`;
  const org = workspaceId == null || workspaceId === '' ? '' : String(workspaceId);
  if (!org || org === '0') {
    return resourcePath(host, path);
  }
  const base = resourcePath(host, path);
  return base ? `${base}?o=${encodeURIComponent(org)}` : null;
}

export function catalogExplorerUrl(
  host: string | null | undefined,
  catalogName: string | null | undefined,
): string | null {
  if (!catalogName) {
    return null;
  }
  return resourcePath(host, `/explore/data/${encodeURIComponent(catalogName)}`);
}

export function schemaExplorerUrl(
  host: string | null | undefined,
  catalogName: string | null | undefined,
  schemaName: string | null | undefined,
): string | null {
  if (!catalogName || !schemaName) {
    return null;
  }
  return resourcePath(
    host,
    `/explore/data/${encodeURIComponent(catalogName)}/${encodeURIComponent(schemaName)}`,
  );
}

export function tableExplorerUrl(
  host: string | null | undefined,
  catalogName: string | null | undefined,
  schemaName: string | null | undefined,
  tableName: string | null | undefined,
): string | null {
  if (!catalogName || !schemaName || !tableName) {
    return null;
  }
  return resourcePath(
    host,
    `/explore/data/${encodeURIComponent(catalogName)}/${encodeURIComponent(schemaName)}/${encodeURIComponent(tableName)}`,
  );
}

export function parseTableFullName(
  fullName: string | null | undefined,
): { catalog: string; schema: string; table: string } | null {
  if (!fullName) {
    return null;
  }
  const parts = fullName.split('.');
  if (parts.length < 3) {
    return null;
  }
  return {
    catalog: parts[0],
    schema: parts[1],
    table: parts.slice(2).join('.'),
  };
}

export function tableUrlFromFullName(
  host: string | null | undefined,
  fullName: string | null | undefined,
): string | null {
  const parsed = parseTableFullName(fullName);
  if (!parsed) {
    return null;
  }
  return tableExplorerUrl(host, parsed.catalog, parsed.schema, parsed.table);
}

export function workspaceResourceUrl(
  host: string | null | undefined,
  kind: string | null | undefined,
  resourceId: string | number | null | undefined,
  workspaceId?: string | number | null,
): string | null {
  switch (kind) {
    case 'job':
      return jobUrl(host, resourceId);
    case 'endpoint':
    case 'serving_endpoint':
      return servingEndpointUrl(host, resourceId == null ? null : String(resourceId));
    case 'app':
      return appDetailsUrl(host, resourceId == null ? null : String(resourceId), workspaceId);
    case 'warehouse':
      return warehouseUrl(host, resourceId == null ? null : String(resourceId));
    case 'cluster':
      return clusterUrl(host, resourceId == null ? null : String(resourceId));
    case 'pipeline':
      return pipelineUrl(host, resourceId == null ? null : String(resourceId));
    case 'vector_search':
      return vectorSearchUrl(host, resourceId == null ? null : String(resourceId));
    case 'agent':
    case 'knowledge_assistant':
      return knowledgeAssistantUrl(host, resourceId == null ? null : String(resourceId));
    case 'genie':
    case 'genie_space':
      return genieSpaceUrl(host, resourceId == null ? null : String(resourceId), workspaceId);
    default:
      return null;
  }
}

-- Executes on behalf of the signed-in user.
SELECT
  workspace_id,
  workspace_name,
  workspace_url,
  status
FROM system.access.workspaces_latest
ORDER BY workspace_name
LIMIT 500;

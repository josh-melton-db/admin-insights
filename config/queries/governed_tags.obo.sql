-- Executes on behalf of the signed-in user.
-- Account governed tags that are not deleted. Usage counts are in governed_tag_usage.
-- @param limit INT
SELECT
  tag_key,
  change_time AS last_changed
FROM system.tags.governed_tags
WHERE deleted_at IS NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY tag_key ORDER BY change_time DESC) = 1
ORDER BY tag_key
LIMIT :limit;

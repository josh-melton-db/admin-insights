# apps-monitoring bundle

A standalone Declarative Automation Bundle for Databricks Apps hygiene. It
answers "what can we safely delete?" It deploys:

- **Job `apps-monitoring`** (daily, 06:00 UTC, `max_concurrent_runs: 1`):
  1. `snapshot_apps_inventory`: a serverless Python task. It reads the Apps API
     (`apps.list` + `apps.get`) and SCIM, then overwrites
     `${catalog}.${schema}.${name_prefix}apps_inventory_snapshot`.
  2. `refresh_app_mvs`: a SQL file task on the warehouse. It ensures the
     bundle's two Apps MVs (`${name_prefix}app_obo_activity_daily`,
     `${name_prefix}app_config_events_daily`) exist, drops any schedule, and
     refreshes them.
  3. `refresh_dashboard`: a dashboard task that refreshes the dashboard below.
- **Dashboard `Databricks Apps monitoring`**: an AI/BI dashboard with the pages
  Overview, Deletion candidates, Creators, and Filters.

The dashboard only flags candidates. Nothing in this bundle stops or deletes an
app.

> This bundle is separate from the repo-root `databricks.yml`, which deploys
> the live `admin-insights` app. Run every command below from
> `bundles/apps-monitoring/`. Never deploy the root bundle from here.

## Deploy and run

```bash
cd bundles/apps-monitoring
databricks bundle validate --profile DEFAULT
databricks bundle deploy --profile DEFAULT
databricks bundle run apps_monitoring --profile DEFAULT
databricks bundle summary --profile DEFAULT   # job + dashboard URLs
```

To change the namespace or prefix, override the variables **at deploy time**:
`databricks bundle deploy --profile DEFAULT --var catalog=main --var schema=ops --var name_prefix=ops_`.
Do not override the `catalog`/`schema`/`name_prefix` job parameters at run
time (`bundle run --params` or "Run now with different parameters"). The job
would then write and refresh one set of tables while the dashboard, whose
dataset catalog/schema and table names are bound at deploy time, keeps reading
the other.

Unit tests (they mock the Apps API and Spark, and statically check that every
table reference in the job, SQL, and dashboard carries the prefix):
`python3 -m pytest -q tests/`.

To remove everything: `databricks bundle destroy --profile DEFAULT`. This
removes the job and the dashboard. It leaves the prefixed MVs and snapshot
table in place, and those MVs then have no refresher. Drop them manually if
you no longer need them.

## Variables

| Variable | Default | Used by |
|----------|---------|---------|
| `warehouse_id` | `2fe54b32b36329be` | `refresh_app_mvs` SQL task, dashboard warehouse, `refresh_dashboard` task |
| `catalog` | `demos` | job parameter `catalog`, dashboard `dataset_catalog` |
| `schema` | `admin_insights` | job parameter `schema`, dashboard `dataset_schema` |
| `name_prefix` | `""` (the `default` target sets `monitor_`) | job parameter `name_prefix`, every table name in the job and dashboard |

The catalog, schema, and prefix reach the tasks as job parameters, not config
files. Both tasks fail fast on a catalog or schema that doesn't fully match
`^[A-Za-z0-9_]+$`, or a prefix that doesn't fully match `^[A-Za-z0-9_]*$`
(empty allowed), before using them in SQL:

- The Python task receives `--catalog/--schema/--name-prefix` and checks them
  with `re.fullmatch`.
- The SQL file receives the named markers `:catalog/:schema/:name_prefix`. It
  strips the allowed characters and requires an empty remainder, since RLIKE's
  `$` also matches before a trailing newline. The values are used via
  `EXECUTE IMMEDIATE`, because `ALTER`/`REFRESH MATERIALIZED VIEW` don't accept
  `IDENTIFIER()`.

Dashboard dataset SQL uses `${var.name_prefix}`-prefixed table names without a
catalog or schema (for example `monitor_apps_inventory_snapshot`). The bundle's
`dataset_catalog`/`dataset_schema` fill those in. Only `system.billing.usage`
is fully qualified.

The dashboard JSON is inline in `resources/apps_monitoring.dashboard.yml`
(`serialized_dashboard`) rather than in a `file_path` `.lvdash.json`. The CLI
substitutes `${var.*}` in YAML strings but not inside a `file_path` file. To
edit the layout in the UI, export the dashboard JSON, replace each table name's
`monitor_` with `${var.name_prefix}`, and paste it back under
`serialized_dashboard: |`.

## Tables

All three live in `${catalog}.${schema}` and carry `name_prefix` (with the
`default` target: `monitor_apps_inventory_snapshot`,
`monitor_app_obo_activity_daily`, `monitor_app_config_events_daily`).

- `${name_prefix}apps_inventory_snapshot` (overwritten daily): one row per app, with these
  fields:
  - `snapshot_time`, `workspace_id`, `app_name`, `app_id`, `description`
  - `creator`, `creator_type` (`user` / `sp` / `unknown`), `creator_active`
  - app state, compute state and size
  - create, update, and updater
  - active and pending deployment id, state, and time
  - service principal id, name, and client id
  - `oauth2_app_client_id`, `url`, `user_api_scopes`, `effective_user_api_scopes`
  - budget policy ids
  - `metadata_incomplete`: `apps.get` failed for this app with a non-auth error,
    so the row only has `apps.list` fields. `app_state`, `user_api_scopes`, and
    `effective_user_api_scopes` are then NULL (unknown), not empty.

  Apps deleted between `apps.list` and `apps.get` (NotFound) are skipped. Auth
  errors fail the task, as does any run where at least one `apps.get` failed
  and none succeeded (NotFound skips don't count as successes). Zero listed
  apps, or only confirmed-deleted ones, writes an empty snapshot.

  `creator_active` comes from a SCIM lookup:
  - The creator matches a `userName` → `user`, with SCIM `active`.
  - The creator matches an SP `applicationId`/`displayName` → `sp`, with SCIM
    `active`.
  - Not found, email-shaped → `user`, `creator_active = false` (confirmed
    missing).
  - Not found, UUID-shaped → `sp`, `creator_active = false`.
  - Not found, any other shape, or no creator → `unknown`,
    `creator_active = NULL`.
- `${name_prefix}app_obo_activity_daily`, `${name_prefix}app_config_events_daily`:
  copies of the Apps MVs in `sql/governance/06_app_activity_daily_mvs.sql`
  (same SELECTs, 90-day rolling window, same columns). A test checks that the
  SELECTs stay in sync.

## MV ownership and decoupling from admin-insights

The bundle owns its own prefixed MVs and does not touch the admin-insights
app's shared MVs (`app_obo_activity_daily`, `app_config_events_daily`), which
refresh themselves again with `SCHEDULE EVERY 1 DAY`.

For the bundle's prefixed MVs, the **apps-monitoring job is the single
refresher**:

- `refresh_app_mvs.sql` runs `CREATE MATERIALIZED VIEW IF NOT EXISTS` with no
  `SCHEDULE`. This is a no-op when the MV exists.
- It then runs `ALTER MATERIALIZED VIEW … DROP SCHEDULE`. This is made
  idempotent by swallowing only `DROP_SCHEDULE_SCHEDULE_DOES_NOT_EXIST` and
  re-raising any other error.
  The handler reads `GET DIAGNOSTICS … CONDITION_IDENTIFIER`, because the
  SQLSTATE is the generic `42000`.
- It finishes with `REFRESH MATERIALIZED VIEW` on each MV, synchronously.
- The task retries up to twice, 2 minutes apart, on transient warehouse
  errors. Every step is idempotent.

With `name_prefix` set to `""`, the bundle targets the unprefixed shared MVs
and would drop their schedules, which is how it behaved before the prefix
existed. Don't deploy with an empty prefix while the admin-insights app relies
on those schedules.

**Leftover table:** earlier deploys wrote an unprefixed
`demos.admin_insights.apps_inventory_snapshot`. Nothing reads it now. It is
left in place and is safe to drop manually:
`DROP TABLE demos.admin_insights.apps_inventory_snapshot`.

## Flag definitions

The thresholds are dashboard parameters on the **Filters** page:

| Parameter | Default |
|-----------|---------|
| `usage_days` | 30 (clamped to 1–90, the MV retention) |
| `stale_days` | 60 |
| `creator_app_threshold` | 3 |

**Window semantics:** "the last N days" means `date >= current_date() - N`.
That is inclusive, so it covers N full days plus today (UTC). `stale_days`
compares the last deploy/update timestamp against `current_date() - stale_days`.

"OBO" means user on-behalf-of activity in `app_obo_activity_daily`. An OBO row
is matched to an app when the last path segment of `acting_resource` equals the
app's `oauth2_app_client_id`, `id`, or `name`. Audit records `acting_resource`
as `accounts/<acct>/oauth2/custom-app-integrations/<oauth2_app_client_id>`.

| Flag | Definition |
|------|-----------|
| `no_usage` | No OBO events in the last `usage_days`. Billing alone is not usage. |
| `billed_no_users` | DBUs in `system.billing.usage` (`usage_metadata.app_id`) in the last `usage_days`, with zero OBO users. |
| `sp_only` | `user_api_scopes` is known and empty (from the Apps API snapshot), and there are no OBO events in the window. The app acts only as its service principal. NULL scopes (`metadata_incomplete`) are `scopes_unknown`, not `sp_only`. |
| `stopped_or_never_deployed` | Compute state `STOPPED`/`ERROR`, or no active deployment. |
| `stale_deploy` | The latest of active-deployment time and app `update_time` is more than `stale_days` ago. |
| `creator_inactive` | `creator_active = false`: the creator is a confirmed missing or deactivated user or SP. |
| `creator_unknown` | `creator_active` is NULL (the creator couldn't be classified). Shown in reasons; never a delete signal. |
| `scopes_unknown` | `user_api_scopes` is NULL because of `metadata_incomplete`. Shown in reasons; never a delete signal. |
| `over_creator` | The creator owns more than `creator_app_threshold` existing apps. |

An app is a **deletion candidate** when it is `no_usage` AND at least one of
these holds:

- It declares `user_api_scopes`, meaning it was built for users and no one used it.
- It is `stopped_or_never_deployed`.
- It is `stale_deploy`.
- It is `creator_inactive`.

SP-only apps, and apps with unknown scopes, are not candidates without a
corroborating signal, because OBO can't see their usage.

**Wasted DBUs** = DBUs in the window for `billed_no_users` apps.

## Dashboard

- **Overview**:
  - KPIs: total apps, apps with no usage, deletion candidates, creators over
    the threshold, wasted DBUs, stopped/never deployed.
  - Daily DBUs by app over 90 days (top 7 apps plus Other).
  - Daily OBO users and events.
- **Deletion candidates**: one row per app, with these columns:
  - reasons
  - last usage (billed) date and last OBO date
  - OBO users and DBUs
  - creator and creator-active
  - compute and app state
  - last deploy and last update
  - scopes

  The page has filters for candidate/keep, compute state, and creator.
- **Creators**: an apps-per-creator bar chart for creators over the threshold,
  plus a drill table that cross-filters with the bar.
- **Filters**: global parameter inputs for the three thresholds.

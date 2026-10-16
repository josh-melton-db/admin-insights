# apps-monitoring bundle

A standalone Declarative Automation Bundle for Databricks Apps hygiene. It
answers "what can we safely delete?" It deploys:

- **Job `apps-monitoring`** (daily, 06:00 UTC, `max_concurrent_runs: 1`):
  1. `snapshot_apps_inventory`: a serverless Python task. It reads the Apps API
     (`apps.list` + `apps.get`) and SCIM, then overwrites
     `${catalog}.${schema}.${name_prefix}apps_inventory_snapshot`.
  2. `refresh_app_mvs`: a SQL file task on the warehouse. It runs
     `CREATE OR REPLACE` on the bundle's three Apps MVs
     (`${name_prefix}app_obo_activity_daily`,
     `${name_prefix}app_config_events_daily`,
     `${name_prefix}app_access_activity_daily`), which applies any definition
     change and recomputes them, then drops any schedule.
  3. `refresh_dashboard`: a dashboard task that refreshes the dashboard below.
- **Dashboard `Databricks Apps monitoring`**: an AI/BI dashboard with the pages
  Overview, Deletion candidates, Creators, and Filters.

The dashboard only flags candidates. Nothing in this bundle stops or deletes an
app.

> This bundle is separate from the repo-root `databricks.yml`, which deploys
> the live `admin-insights` app. Run every command below from
> `bundles/apps-monitoring/`. Never deploy the root bundle from here.

## Deploy and run

No workspace host or warehouse ID is committed. The CLI takes the workspace
from `--profile`, and `warehouse_id` (a required variable) from a local,
gitignored overrides file:

```bash
cd bundles/apps-monitoring
mkdir -p .databricks/bundle/default
cp variable-overrides.example.json .databricks/bundle/default/variable-overrides.json
# edit it: replace <sql-warehouse-id> with your serverless SQL warehouse ID
```

`.databricks/` is gitignored, so the real ID stays local. You can also pass
`--var warehouse_id=<id>` on each command. Then:

```bash
databricks bundle validate --profile <profile>
databricks bundle deploy --profile <profile>
databricks bundle run apps_monitoring --profile <profile>
databricks bundle summary --profile <profile>   # job + dashboard URLs
```

To change the namespace or prefix, override the variables **at deploy time**:
`databricks bundle deploy --profile <profile> --var catalog=main --var schema=ops --var name_prefix=ops_`.
Do not override the `catalog`/`schema`/`name_prefix` job parameters at run
time (`bundle run --params` or "Run now with different parameters"). The job
would then write and refresh one set of tables while the dashboard, whose
dataset catalog/schema and table names are bound at deploy time, keeps reading
the other.

Unit tests (they mock the Apps API and Spark, and statically check that every
table reference in the job, SQL, and dashboard carries the prefix):
`python3 -m pytest -q tests/`.

To remove everything: `databricks bundle destroy --profile <profile>`. This
removes the job and the dashboard. It leaves the prefixed MVs and snapshot
table in place, and those MVs then have no refresher. Drop them manually if
you no longer need them.

## Variables

| Variable | Default | Used by |
|----------|---------|---------|
| `warehouse_id` | none (required; set in `variable-overrides.json`) | `refresh_app_mvs` SQL task, dashboard warehouse, `refresh_dashboard` task |
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
  `EXECUTE IMMEDIATE`, because `CREATE`/`ALTER MATERIALIZED VIEW` don't accept
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

All four live in `${catalog}.${schema}` and carry `name_prefix` (with the
`default` target: `monitor_apps_inventory_snapshot`,
`monitor_app_obo_activity_daily`, `monitor_app_config_events_daily`,
`monitor_app_access_activity_daily`).

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
  SELECTs stay in sync. `app_obo_activity_daily` keeps only Databricks Apps
  rows, `acting_resource LIKE 'accounts/%/oauth2/custom-app-integrations/%'`,
  and its last column `oauth2_app_client_id` is the last path segment.
  `identity_metadata.acting_resource_type` is not used: it is `Application
  Service Principal` for databricks-cli and other published OAuth clients too,
  and empty for about a quarter of Apps rows.
- `${name_prefix}app_access_activity_daily` (bundle-only, 90-day window):
  `activity_date`, `workspace_id`, `oauth2_app_client_id`, `user_email`,
  `signal`, `event_count`, where `signal` is one of:
  - `login`: a successful (`status_code = 200`) workspace
    `mintOAuthAuthorizationCode`, the browser sign-in to the app;
    `oauth2_app_client_id` is `request_params.client_id`. Token refreshes,
    token exchange, and `mintOAuthToken` client_credentials are not visits and
    are not included.
  - `consent`: account-level `oauth2.createOrUpdateOAuthAppUserConsentEvent`;
    `oauth2_app_client_id` is `request_params.integration_id` and
    `workspace_id` is not the app's. Kept as a secondary signal; the
    dashboard doesn't use it yet.
  - `sp_activity`: any action by a UUID-shaped identity (a service principal;
    `user_email` is its application ID, `oauth2_app_client_id` is NULL),
    except the token/auth and source-export actions that every running app
    emits (`oidcTokenAuthorization`, `workspaceInHouseOAuthClientAuthentication`,
    `mintOAuthToken`, `tokenLogin`, `workspaceExport`). The dashboard matches
    it to an app on the app's `service_principal_client_id`.

  There is no Apps visit system table. The app Insights viewers and app
  `auth` telemetry are richer sources but are not system tables, so they are
  out of scope here.

## MV ownership and decoupling from admin-insights

The bundle owns its own prefixed MVs and does not touch the admin-insights
app's shared MVs (`app_obo_activity_daily`, `app_config_events_daily`), which
refresh themselves again with `SCHEDULE EVERY 1 DAY`.

For the bundle's prefixed MVs, the **apps-monitoring job is the single
refresher**:

- `refresh_app_mvs.sql` runs `CREATE OR REPLACE MATERIALIZED VIEW` with no
  `SCHEDULE`. That applies definition changes to existing MVs (`IF NOT EXISTS`
  would silently keep an old definition) and recomputes them synchronously,
  even when the definition is unchanged. `system.access.audit` is not a Delta
  source, so a refresh is always a full recompute anyway; a separate
  `REFRESH` would compute everything twice.
- It then runs `ALTER MATERIALIZED VIEW … DROP SCHEDULE`, in case someone added
  a schedule outside the bundle. This is made idempotent by swallowing only
  `DROP_SCHEDULE_SCHEDULE_DOES_NOT_EXIST` and re-raising any other error.
  The handler reads `GET DIAGNOSTICS … CONDITION_IDENTIFIER`, because the
  SQLSTATE is the generic `42000`.
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

**Usage** is a human using the app. Two signals count, both from system tables
and both in the last `usage_days`:

- **Human login** (`human_login_users`, `last_login_date`, `has_human_login`):
  `signal = 'login'` rows in `${name_prefix}app_access_activity_daily` whose
  `oauth2_app_client_id` equals the app's `oauth2_app_client_id`.
- **Human OBO** (`human_obo_users`, `human_obo_events`, `last_obo_date`):
  rows in `${name_prefix}app_obo_activity_daily` whose `oauth2_app_client_id`
  equals the app's. Audit records `acting_resource` as
  `accounts/<acct>/oauth2/custom-app-integrations/<oauth2_app_client_id>`.
  Matching is on the client ID only (it is account-unique). There is no
  workspace match, because most OBO rows have `workspace_id = 0`.

Both exclude the app's own service principal: a row counts only if
`user_email` is email-shaped and is not the app's `service_principal_client_id`.
The app SP does show up with an `acting_resource` sometimes (for example on
`workspaceExport`).

**SP activity** (`sp_events_window`, `last_sp_activity_date`): `signal =
'sp_activity'` rows whose `user_email` is the app's
`service_principal_client_id`. It is background or operational work, not
usage.

**`activity_type`** describes how the app is active in the usage window. Human
login is a separate dimension and is not part of it.

| `activity_type` | Meaning |
|-----------------|---------|
| `SP-only` | SP activity, no human OBO |
| `OBO` | Human OBO, no SP activity |
| `SP and OBO` | Both |
| `Idle` | Neither |

| Flag | Definition |
|------|-----------|
| `no_usage` | No human login AND no human OBO in the last `usage_days`. Billing and SP activity are not usage, so an `SP-only` app with logins is not `no_usage`. |
| `billed_no_users` | DBUs in `system.billing.usage` (`usage_metadata.app_id`) in the last `usage_days`, with zero human login users and zero human OBO users. |
| `sp_only` | `user_api_scopes` is known and empty (from the Apps API snapshot), and there are no human OBO events in the window. The app authorizes only as its service principal. NULL scopes (`metadata_incomplete`) are `scopes_unknown`, not `sp_only`. |
| `idle` | `no_usage` and `activity_type = 'Idle'`: no human login, no human OBO, and no SP activity. |
| `stopped_or_never_deployed` | Compute state `STOPPED`/`ERROR`, or no active deployment. |
| `stale_deploy` | The latest of active-deployment time and app `update_time` is more than `stale_days` ago. |
| `creator_inactive` | `creator_active = false`: the creator is a confirmed missing or deactivated user or SP. |
| `creator_unknown` | `creator_active` is NULL (the creator couldn't be classified). Shown in reasons; never a delete signal. |
| `scopes_unknown` | `user_api_scopes` is NULL because of `metadata_incomplete`. Shown in reasons; never a delete signal. |
| `over_creator` | The creator owns more than `creator_app_threshold` existing apps. |

An app is a **deletion candidate** when it is `no_usage` AND at least one of
these holds:

- It declares `user_api_scopes`, meaning it was built for users and no one used it.
- It is `Idle`: its service principal did nothing either.
- It is `stopped_or_never_deployed`.
- It is `stale_deploy`.
- It is `creator_inactive`.

Being `sp_only` (no user scopes) no longer protects an app on its own. Usage
now includes human logins, which apps without user scopes do produce. An
`sp_only` or scopes-unknown app with no usage is still a candidate only with a
corroborating signal: `Idle`, stopped/never deployed, stale, or inactive
creator.

**Wasted DBUs** = DBUs in the window for `billed_no_users` apps.

## Dashboard

- **Overview**:
  - KPIs: total apps, apps with no usage, deletion candidates, creators over
    the threshold, wasted DBUs, stopped/never deployed.
  - Daily DBUs by app over 90 days (top 7 apps plus Other).
  - Daily human OBO users and events.
- **Deletion candidates**: one row per app, with these columns:
  - activity type, then login users next to it
  - reasons
  - last usage (billed) date, last login date, and last human OBO date
  - human OBO users, last SP activity date, and DBUs
  - creator and creator-active
  - compute and app state
  - last deploy and last update
  - scopes

  The page has filters for candidate/keep, compute state, creator, and
  activity type.
- **Creators**: an apps-per-creator bar chart for creators over the threshold,
  plus a drill table that cross-filters with the bar.
- **Filters**: global parameter inputs for the three thresholds.

# admin-insights

A Databricks App powered by [AppKit](https://www.databricks.com/devhub/docs/appkit/v0/), featuring React, TypeScript, and Tailwind CSS.

**Enabled plugins:**
- **Analytics** -- SQL query execution against Databricks SQL Warehouses
- **Lakebase** -- Fully managed Postgres database for transactional (OLTP) workloads on Databricks
- **Server** -- Express HTTP server with static file serving and Vite dev mode

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI (for deployment)
- Access to a Databricks workspace

## Databricks Authentication

### Local Development

For local development, configure your environment variables by creating a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and set the environment variables you need:

```env
DATABRICKS_HOST=https://example.cloud.databricks.com
DATABRICKS_APP_PORT=8000
# ... other environment variables, depending on the plugins you use
```

#### Lakebase Configuration

The Lakebase plugin requires additional environment variables for PostgreSQL connectivity. To learn how to configure the Lakebase plugin, see the [Lakebase plugin documentation](https://www.databricks.com/devhub/docs/appkit/v0/plugins/lakebase).

### CLI Authentication

The Databricks CLI requires authentication to deploy and manage apps. Configure authentication using one of these methods:

#### OAuth U2M

Interactive browser-based authentication with short-lived tokens:

```bash
databricks auth login --host https://example.cloud.databricks.com --profile <name>
```

This will open your browser to complete authentication. The CLI saves credentials to `~/.databrickscfg`.

#### Configuration Profiles

Use multiple profiles for different workspaces:

```ini
[DEFAULT]
host = https://dev-example.cloud.databricks.com

[production]
host = https://prod-example.cloud.databricks.com
client_id = prod-client-id
client_secret = prod-client-secret
```

Deploy using a specific profile:

```bash
databricks bundle deploy --profile production
```

**Note:** Personal Access Tokens (PATs) are legacy authentication. OAuth is strongly recommended for better security.

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Run the app in development mode with hot reload:

```bash
npm run dev
```

The app will be available at the URL shown in the console output.

### Build

Build both client and server for production:

```bash
npm run build
```

This creates:

- `dist/server.js` - Compiled server bundle
- `client/dist/` - Bundled client assets

### Production

Run the production build:

```bash
npm start
```

## Code Quality

There are a few commands to help you with code quality:

```bash
# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:fix
```

## Deployment with Databricks Asset Bundles

### 1. Configure Bundle

Select an authenticated CLI profile for your workspace. The bundle deliberately
omits `workspace.host`: authentication resolves it from the selected profile,
not from a bundle variable. Keep workspace identifiers out of committed files.

```bash
mkdir -p .databricks/bundle/default
cp variable-overrides.example.json .databricks/bundle/default/variable-overrides.json
```

Replace the placeholders in that local JSON file with your SQL warehouse ID and
full Lakebase project, branch, and database resource names. `.databricks/` is
gitignored; do not commit your overrides. For other targets, use that target's
directory instead of `default`.

The app's runtime command and environment are defined in `databricks.yml`
(`resources.apps.app.config`), not in an `app.yaml`. Set these app settings in
the same overrides file:

| Variable           | Required | Default   | App env var                       |
| ------------------ | -------- | --------- | --------------------------------- |
| `bootstrap_admins` | yes      | —         | `ADMIN_INSIGHTS_BOOTSTRAP_ADMINS` |
| `admin_groups`     | no       | `admins`  | `ADMIN_INSIGHTS_ADMIN_GROUPS`     |
| `execution_mode`   | no       | `dry_run` | `ADMIN_INSIGHTS_EXECUTION_MODE`   |

- `bootstrap_admins`: comma-separated administrator emails (case-insensitive),
  read at startup. `bundle validate` and `bundle deploy` fail if it is unset. The
  example's `you@example.com` is a placeholder: replace it with real emails.
- `admin_groups`: comma-separated workspace group names whose members are admins.
- `execution_mode`: `dry_run` or `live`. Any value other than `live` behaves as
  `dry_run`. The deployed app runs in `dry_run` by default; to enable live mode,
  set `"execution_mode": "live"` in the overrides file.

The bundle also injects `DATABRICKS_WAREHOUSE_ID` and `LAKEBASE_ENDPOINT` from
the `sql-warehouse` and `postgres` app resources.

**Check key names carefully:** the CLI ignores unknown keys in the overrides
file without any error or warning. A misspelled `admin_groups` or
`execution_mode` key therefore falls back silently to its default (`admins` /
`dry_run`). A misspelled `bootstrap_admins` key fails `bundle validate` and
`bundle deploy`, because the required variable is then unset.

`ADMIN_INSIGHTS_DEV_USER` is not set on the deployed app: it is only used when
`NODE_ENV=development` and no trusted proxy identity header is present. For local
development, set it and the settings above in your gitignored `.env` (see
`.env.example`).

**Warning:** if `bootstrap_admins` holds only placeholder addresses, there is no
real bootstrap administrator. Admin access then depends solely on
`admin_groups` membership.

After the first deploy, follow `sql/governance/README.md` to retrieve the app's
`service_principal_client_id` and substitute `<app-service-principal-client-id>`
in a local copy of the grants template. Do not commit the substituted ID.

### 2. Validate Bundle

```bash
databricks bundle validate --profile <name>
```

### 3. Deploy

Deploy to the default target:

```bash
databricks bundle deploy --profile <name>
```

### 4. Run

Start the deployed app:

```bash
databricks bundle run app -t default --profile <name>
```

Changes to the app's env or command (including the variables above) take effect
only on a new app deployment: run `bundle run app` after `bundle deploy`.

### Deploy to Production

Only the `default` target is configured in this repository. To deploy with a
separate `prod` target, first add it to `databricks.yml` and create its own
gitignored `.databricks/bundle/prod/variable-overrides.json` using
`variable-overrides.example.json`. Select the production workspace profile and
set the production resource values before deploying:

```bash
databricks bundle deploy -t prod --profile <name>
```

## Project Structure

```
* client/          # React frontend
  * src/           # Source code
  * public/        # Static assets
* server/          # Express backend
  * server.ts      # Server entry point
  * routes/        # Routes
* shared/          # Shared types
* config/          # Configuration
  * queries/       # SQL query files
* databricks.yml   # Bundle and app runtime configuration
* .env.example     # Environment variables example
```

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React.js, TypeScript, Vite, Tailwind CSS, React Router
- **UI Components**: Radix UI, shadcn/ui
- **Databricks**: AppKit SDK

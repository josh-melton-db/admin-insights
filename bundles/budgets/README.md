# Workspace budgets notebook

Workspace-admin budgets as code, through the account Budgets API, in one notebook, following
`../usage-policies/`. This is a standalone notebook sub-project, **not** an Admin
Insights app feature or a deployable DAB. There is no YAML/JSON configuration.

- `src/manage_budgets.py`: declare, widgets, validate, plan, gated apply, import, report.
- `src/budgets_lib.py`: validation, thin account REST client, reconciliation, export, SQL.
- `tests/test_budgets_lib.py`: fake-client unit tests; no network or credentials required.
- `tests/live_smoke.py`: explicit-profile live gates, with an opt-in isolated lifecycle test.
- `SPEC.md`: API evidence, ownership decisions, limitations, and verification status.

## Credentials and permissions

Budget calls **require account-host credentials**, not a workspace token sent to
the account host. The authentication design is the proven `Config` / `AccountClient`
path from `notebooks/budget_api_auth.ipynb` on `feat/budget-api-notebook`.
There is no fallback to workspace credentials, default profile, or a different profile.

**Local:** select an existing account-level CLI profile explicitly:

```bash
export DATABRICKS_ACCOUNT_PROFILE=budget-account-test
```

The account ID is read from that profile; the optional `account_id` override wins.
The resolved host must be an allowlisted HTTPS Databricks accounts host. Environment
overrides recognized by the SDK must also resolve to that account host. Do not mix
workspace-token environment overrides with an account profile.

**Databricks runtime (default `account_auth=interactive`):** supply `account_id`
and run the sign-in cell. It creates an SDK OAuth consent with authorization-code
+ PKCE S256, without a localhost listener or opening a browser on the server.
Open the displayed link yourself. After signing in, the browser reaches an expected
failed localhost page. Copy its **full address** into `account_signin_redirect`
and run the **next cell**, then continue below it. Do not re-run the sign-in cell
or Run all after pasting: that intentionally replaces the consent, invalidating
the old callback. Run all with no pasted input exits cleanly after displaying the link.

The full redirected URL verifies the returned state. A code-only paste is also
supported, using the pending consent's state and PKCE verifier; it cannot independently
verify the returned state, so prefer the full URL. The callback widget is cleared
by removing the widget after every exchange attempt (the sign-in cell recreates it).
Do not paste into source or print the callback;
platform widget/history retention is outside the Python session's control. Never
share/export a notebook while signing in. Consent, verifier, access token and refresh
token stay in Python memory only; nothing is serialized by this project. Stale/reused
codes or mismatched state require re-running the sign-in cell and signing in again.
The account ID cannot be discovered without account credentials here: keep supplying
the existing `account_id` widget. No workspace credential fallback is permitted.

This uses the built-in **`databricks-cli` public OAuth client**, with scopes
`all-apis` and `offline_access`, and redirect `http://localhost:8020`. The Databricks
"Manually generate OAuth U2M access tokens" documentation supports this manual flow,
but recommends registering a **custom OAuth application for non-built-in tools**;
organization policy may therefore require a custom client before adopting this pattern.
Access tokens last about **one hour**; SDK `SessionCredentials` refreshes them only
for the live Python session. Restarting/detaching requires fresh interactive sign-in.

**Scheduled/unattended runs (`account_auth=secret`):** supply the account ID and
scope/key of an existing secret containing an **account-host bearer token**. The
caller needs permission to read that secret. The runtime constructs
`Config(host=account_host, account_id=..., token=..., auth_type="pat")`; it never
asks the notebook workspace for its token. Provision and rotate secrets through
your normal secure process, never in notebook source/output. Interactive mode does
not read the secret widgets' values as credentials or access the secret store.

The primary caller is a **workspace admin**, managing budgets scoped to their own
workspace. Locally, `WorkspaceClient(profile="DEFAULT")` discovers that workspace;
in the notebook, `WorkspaceClient()` uses the current notebook context. Its ID is
passed to validation as the default scope; it is never hard-coded or printed.
That workspace client is **not** used to authenticate budget calls.

Unfiltered/account-wide budgets require an account admin and explicit
`scope="account"` opt-in. The account-wide smoke returned 403, as expected for the
workspace-admin caller. A workspace-filtered create/update/delete lifecycle passed
with the **same account profile**, without new grants or switching credentials.
For reporting, separately grant the notebook's workspace identity `SELECT` on
`system.billing.usage` and `system.billing.list_prices`, plus catalog/schema access.
No account-admin credential is passed to Spark.

## Import and run

Keep the two `src/` files together in a workspace folder, open `manage_budgets`,
and attach serverless or a runtime supporting `spark.sql(..., args=parameters)`.
For example, an administrator can import the sources themselves (this project does
not deploy a workspace resource):

```bash
databricks workspace import-dir bundles/budgets/src /Users/<you>/budgets --profile <workspace-profile>
```

Run the first `%pip install --upgrade databricks-sdk` cell, then the separate
`%restart_python` cell before running any Python, widgets, or declarations. The
runtime SDK confirmed on 2026-10-19 is **0.154.0**; the upgrade uses the latest
available release. Restarting discards any pending sign-in and session credentials.
Edit the declaration cell, then continue through the remaining cells (or run all
from the beginning before starting sign-in). Validation collects every declaration
and date-range error **before any budget API call**, after discovering the workspace.
Never share private import-cell output
or commit runtime IDs, emails, hosts, tokens, or exported live configuration.

| Widget | Default | Meaning |
|---|---|---|
| `apply` | `false` | Enables mutations only when `true`. |
| `allow_deletes` | `false` | Deletion also requires this to be `true`. |
| `account_id` | empty | Runtime requirement; optional local profile override. |
| `account_host` | public AWS accounts host | Runtime accounts host; AWS, Azure, and GCP accounts hosts are allowlisted. Local host comes only from the selected profile. |
| `account_auth` | `interactive` | Runtime `interactive` or `secret`; local runs always use the explicit account profile. |
| `account_signin_redirect` | empty | Full redirected localhost URL (preferred) or code; consumed and cleared by the next cell. |
| `account_token_secret_scope` | empty | Account-token secret scope, only for `secret` mode. |
| `account_token_secret_key` | empty | Account-token secret key, only for `secret` mode. |
| `report_start_date` | 30 days ago | Inclusive `YYYY-MM-DD` usage date. |
| `report_end_date` | today | Exclusive `YYYY-MM-DD` usage date. |

## Declare budgets

```python
BUDGETS = [
    {
        "name": "example-team-monthly",
        "amount": "100",
        "time_period": "MONTH",
        "quantity_type": "LIST_PRICE_DOLLARS_USD",
        "trigger_type": "CUMULATIVE_SPENDING_EXCEEDED",
        "notification_emails": [],
        "tags": {"project": ["example-project"], "team": ["example-a", "example-b"]},
    },
]
MANAGED_BUDGET_IDS = []
```

The notebook refuses to apply shipped `example-*` names. Replace them first.
Recipient emails and workspace IDs must be entered at runtime, not committed.

- `name`, `amount`, `notification_emails` are required. An empty recipients list
  declares no notification actions; this was live-verified on the throwaway budget.
- `name`: unique, nonblank, maximum 128 characters. `amount`: finite, strictly
  positive numeric value, serialized as a decimal string.
- The simple form declares one shared monthly USD list-price threshold. Period,
  quantity, and trigger default to the enums shown above; arbitrary enums are rejected.
- `scope` defaults to `"workspace"`; `workspace_id` defaults to the discovered current
  workspace. The actual write scope is `filter.workspace_id={"operator":"IN",
  "values":[current_workspace_id]}`. The top-level `workspace_id` seen on GET is
  resource metadata and **must not be sent on create/update**: create rejects it.
- Optional `workspace_ids` defaults to that same singleton in workspace scope and
  must agree with it. For explicit `scope="account"`, omit `workspace_id` and omit
  `workspace_ids` for an account-wide budget, or provide workspace filters explicitly.
  The caller must administer any explicitly selected target workspace.
- Optional `tags`: case-sensitive keys mapping to nonempty lists of
  allowed values. Filters combine with AND; alternatives within one filter use IN.
- Optional `budget_id`: identifies an existing budget, independent of its name.
  Optional `adopt=True`: explicit authorization to manage that particular ID.

### Existing resource-specific and multi-alert budgets

Import round-trips all 22 observed budgets, including workspace resource metadata,
AI Gateway resource scope, shared/per-user alerts, principal overrides, and blocking
actions. The advanced form uses `alerts` **instead of** the simple threshold fields:

```python
{
    "name": "example-advanced",
    "resource_type": "BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY",
    "alerts": [{
        "quantity_threshold": "100",
        "scope_type": "ALERT_CONFIGURATION_SCOPE_TYPE_SHARED",
        "action_configurations": [],
    }],
}
```

`alerts` uses the API's `quantity_threshold`, `time_period`, `quantity_type`,
`trigger_type`, `scope_type`, `action_configurations`, and `principal_overrides`.
Defaults fill the monthly/list-USD/cumulative/shared fields. Known email and
`BLOCK_USAGE` actions, notification behavior, and principal overrides are retained;
applying a declaration with blocking actions can restrict usage, so inspect imports
carefully before adoption. Existing alert/action IDs are retained in advanced imports
but ignored when comparing semantic differences. Server timestamps are not editable.
Unknown fields/enums fail validation or produce an explicit import skip, never a
silent lossy replacement. Non-list pricing and external-spend configurations are
not supported by the documented write schema and are rejected.

The documented resource types are all resources and Unity AI Gateway. Product type
is derived from resource type (or checked for consistency if supplied); product,
pricing, external-spend, and top-level workspace metadata are not sent as writable
fields. `resource_type`, the full alert list, and filters **are** sent.

## Ownership, plan, and apply

**There is no reliable managed marker in the documented BudgetConfiguration.**
Filter tags select billed usage: adding a marker there would change the budget's
meaning. Names are not ownership. Ownership is an explicit, notebook-local registry
of budget IDs in `MANAGED_BUDGET_IDS`, not automatically rediscovered state.

1. Import existing budgets from cell 6. It prints a ready-to-paste `BUDGETS` Python
   literal for representable budgets, retaining IDs but setting `adopt=False`.
   Treat that output as private configuration; do not commit it.
2. Select the entries you intend to manage. Either set `adopt=True` on each chosen
   ID or add that ID to `MANAGED_BUDGET_IDS` explicitly. Merely pasting an export
   or matching a name does **not** authorize a write.
3. Inspect the plan. New name: `create`; unmanaged matching name: `error`;
   explicit adoption: `adopt`; owned difference: `update`; owned match: `no-op`.
   An explicit missing ID is an error, never a replacement create.
4. With `apply=true`, apply performs a fresh GET snapshot check before each update
   or delete, and a fresh collision check before create. Updates PUT the **full**
   desired writable budget object, including the ID and account ID. Field-level diffs list
   changed field names without printing recipients or IDs.
   A no-difference adoption is registry-only (GET verification, **no PUT**). Plan,
   pre-mutation checks, and verification compare writable live fields directly to
   desired writable fields, without a lossy declaration round-trip. Harmless server
   metadata/defaults and decimal formatting are normalized, but duplicate actions
   are retained for comparison. Registered IDs missing from the live list produce
   visible error rows, not silent omissions or replacement creates.
5. After a create/adopt, copy its ID from import into both its declaration and the
   ownership registry for subsequent runs. There is no hidden durable state.
6. To delete, remove its declaration **but retain its ID in the registry**. The
   resulting delete requires both `apply=true` and `allow_deletes=true`. Remove
   its registry ID after confirming deletion. Empty declarations never sweep
   all live budgets; only explicitly registered IDs can be deleted.

Live reads can expose newer fields beyond the published schema. All 22 currently
observed budgets export and round-trip to no-op plans; no pre-existing budget was
modified to verify this. **An export is not a complete account inventory** if future
unknown shapes cause skips; do not use a partial export as a deletion manifest.

There is no documented compare-and-swap or create idempotency key. Snapshot checks
reduce races but do not provide transactional isolation. Never run concurrent
writers. A failed create may have succeeded remotely: re-import and inspect before
retrying, never blindly repeat. Writes are followed by bounded GET verification;
unconfirmed/failed outcomes stop the notebook before later cells. API error bodies
and credentials are never printed. Deletion is irreversible.

## Spend versus budget

The report runs parameterized Spark SQL, using the notebook workspace identity.
It matches the declared account, workspace IN filters, and case-sensitive tag IN
filters. It joins usage to USD list prices by SKU, cloud, unit, and effective time,
and sums `usage_quantity * pricing.effective_list.default` per calendar month.
Each row shows estimated spend, the full monthly threshold, percent used, amount
over threshold, partial-month flag, and count of unpriced usage rows.

This is an **estimated list-cost report**, not an invoice or the budget alert engine:
discounts, credits, taxes, external charges, late ingestion, corrections, daily/time
boundaries, and price changes inside one usage record may differ. Partial months
are not prorated. No usage produces no monthly row. Missing prices remain visible
as `unpriced_rows`; a nonzero count means the cost/percentage is incomplete, not a
confirmed underspend. Quantities in different units are never summed together.
Each shared all-resource threshold is reported separately. AI Gateway-only costs,
external spend, and per-user principal attribution cannot be faithfully isolated
by this query; those report rows emit an explicit limitation rather than silently
presenting all-product/aggregate spend as a matching budget comparison. Import,
planning, and apply still preserve their supported resource/alert semantics.

## Validation

Local prerequisites: Python 3.10+, `databricks-sdk`, and `pytest`. Ruff and mypy
are optional development checks; no workspace compute is needed for unit tests.

```bash
python -m pytest bundles/budgets/tests -q
python -m py_compile bundles/budgets/src/budgets_lib.py bundles/budgets/src/manage_budgets.py
DATABRICKS_ACCOUNT_PROFILE=budget-account-test python bundles/budgets/tests/live_smoke.py
```

The live read-only gate uses account profile `budget-account-test` and workspace
profile `DEFAULT` explicitly. It runs plan + import with `apply=False` and GETs
both billing tables' metadata. It prints only counts, operation names, and HTTP
statuses, not resource IDs, names, recipients, hosts, or response bodies. It does
not submit SQL locally because statement submission uses POST; report SQL execution
must be checked in the notebook and remains untested here.

The **separately authorized** throwaway gate is opt-in, not part of pytest:

```bash
DATABRICKS_ACCOUNT_PROFILE=budget-account-test python bundles/budgets/tests/live_smoke.py --throwaway
```

It attempts exactly one `zz-foreman-throwaway-<random>` create through the real
apply path, with the discovered DEFAULT workspace filter, a unique tag filter, and no recipients, then verifies, updates once,
and deletes through the apply path with both gates. A guard refuses mutation of
any other ID, and `try/finally` cleanup recovers only that unique newly created name.
This gate passed: create/GET/update/delete HTTP 200, post-delete GET HTTP 404,
zero left behind and zero pre-existing budgets mutated. HTTP retry guards prevent
an automatic second create/update attempt. Earlier rejected requests created zero
budgets: account-wide POST returned 403; adding read-only top-level `workspace_id`
returned 400 and explicitly instructed using the filter instead. Error diagnostics
print only error code/message with IDs, hosts, emails, and tokens masked. Do not
change profiles or broaden permissions automatically after a 403.

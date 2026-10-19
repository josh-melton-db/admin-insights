# Workspace budgets notebook specification

This directory mirrors the layout and declare/plan/apply/import/report workflow of
`../usage-policies/`, but uses the account Budgets API and account credentials.
It does not modify the app, other bundles, authentication notebook, or workspace.
Primary use case: a workspace admin manages budgets scoped to their own workspace,
using an account-host credential. Account-wide management is an explicit admin-only opt-in.

## API evidence (2026-10-19)

### Interactive authentication evidence (2026-10-19)

- Step 0 passed on the explicitly authorized CLI profile `DEFAULT`: a one-off
  serverless environment **5** notebook GET of the account OIDC discovery endpoint
  returned **HTTP 200**. The run terminated `SUCCESS`; the temporary
  workspace notebook was deleted. No login, token exchange, or budget mutation
  was performed. No dependencies were installed on serverless.
- Discovery advertises `authorization_code`, `refresh_token`, `client_credentials`,
  PKCE `S256`, and token authentication method `none`. Device flow is not supported.
  The manual flow uses public client `databricks-cli`, redirect
  `http://localhost:8020`, and scopes `all-apis`, `offline_access`. A custom OAuth
  application is recommended by Databricks for non-built-in tools. Background
  exploration verified authorize accepts the redirect without completing login;
  this change does not claim a completed human sign-in.
- Source inspection of `databricks.sdk.oauth` in **0.154.0** (isolated test
  environment), locally installed **0.114.0**, and the **0.67.0** wheel confirms
  that `OAuthClient.from_host` takes no account ID and constructs `Config` with
  only the host. Identical helper signatures do **not** establish account-host
  compatibility: 0.114.0 requires an account ID for account endpoints; 0.67.0
  selects generic `/oidc/v1/*` endpoints without it. The notebook instead uses
  explicit `OidcEndpoints` for `{host}/oidc/accounts/{account_id}/v1/authorize`
  and `/token`, after validating host/account ID. No discovery call is needed.
  The shared constructor arguments are:

  ```python
  OAuthClient(oidc_endpoints, redirect_url, client_id, scopes=None, client_secret=None)
  OAuthClient.initiate_consent(self) -> databricks.sdk.oauth.Consent
  Consent.exchange(self, code: str, state: str) -> databricks.sdk.oauth.SessionCredentials
  ```

- 0.154.0 adds an optional `group_id=None` constructor argument; this flow does
  not use it. The real SDK authorization URL test checks the account-scoped
  prefix, public client, redirect, scopes and PKCE S256 without a network call.
  The notebook now upgrades the SDK in its first `%pip` cell and runs a separate
  `%restart_python` cell before imports/widgets/declarations. The user-confirmed
  runtime version and isolated test version are **0.154.0** (2026-10-19).
- The upstream v0.154.0 release notes contain no budget or account OAuth changes.
  Its `billing.BudgetsAPI` still sends account-host requests to
  `/api/2.1/accounts/{account_id}/budgets`; workspace-admin access does not switch
  these calls to workspace credentials. This is source verification, not a new
  live permissions test. The newer SDK includes budget `resource_type`,
  `scope_type` and `principal_overrides` fields already handled by this library.

- `Consent.authorization_url` carries the state; `Consent.exchange` checks state
  and exchanges using its in-memory PKCE verifier. The notebook also checks URL
  state before exchange, rejects ambiguous/missing callback parameters, and clears
  the input widget on consumption. Code-only pastes use pending state, so cannot
  independently verify returned state. No `external-browser` auth, listener,
  consent serialization, or token persistence is used. The `Config` credential
  provider calls `SessionCredentials.token()` for each authorization header,
  retaining SDK refresh for the session rather than freezing an access token.
- Runtime mode defaults to `interactive`; scheduled/unattended runs explicitly
  use `secret`. Local runs keep `DATABRICKS_ACCOUNT_PROFILE`. Hosts and account IDs
  pass the existing validation before consent/secret access and on the final Config.
  Platform retention of pasted widget inputs is outside this code's control;
  users must not share/export a notebook during sign-in.
- Secret/profile authentication errors propagate so scheduled runs fail. Only
  interactive waiting/retry paths exit cleanly; callback widget removal is
  restricted to interactive mode. Deferred review follow-ups N1/N2/S1/S3 remain
  outside this fix round.

### Budget API evidence

Official API pages were fetched and their rendered schema inspected. The old
`/api/account/budgets/{create,get,list,update,delete}` URLs redirect to the links
below. The official Python SDK's `billing.BudgetsAPI` independently confirms REST
verbs, paths, envelopes, and full replacement semantics. Docs and live responses
are not identical. The table distinguishes public documentation, GET-only evidence,
and the separately authorized single throwaway lifecycle; no pre-existing object
was mutated.

| Contract | Evidence status | Official source / observations |
|---|---|---|
| POST `/api/2.1/accounts/{account_id}/budgets`, body `{"budget": {...}}`, response `budget` | **docs-verified; live-verified (authorized throwaway)**, HTTP 200 | [Create](https://docs.databricks.com/api/budgets/v1/create-budget-configuration). Workspace singleton filter, unique tag, empty actions. |
| GET `/api/2.1/accounts/{account_id}/budgets/{budget_id}`, response `budget` | **live-verified (GET only)**, HTTP 200 | [Get](https://docs.databricks.com/api/budgets/v1/get-budget-configuration). Read existing budgets only. |
| GET `/api/2.1/accounts/{account_id}/budgets`, response `budgets`, `next_page_token`; query `page_token` | **live-verified (GET only)**, HTTP 200, 22 budgets | [List](https://docs.databricks.com/api/budgets/v1/list-budget-configurations). Pagination mechanics also covered by fake-client tests. |
| PUT `/api/2.1/accounts/{account_id}/budgets/{budget_id}`, body `budget`, full replacement (not PATCH) | **docs-verified; live-verified (authorized throwaway)**, HTTP 200 | [Update](https://docs.databricks.com/api/budgets/v1/update-budget-configuration). Full writable object and IDs; updated amount GET-confirmed. |
| DELETE `/api/2.1/accounts/{account_id}/budgets/{budget_id}`; irreversible | **docs-verified; live-verified (authorized throwaway)**, HTTP 200, then GET 404 | [Delete](https://docs.databricks.com/api/budgets/v1/delete-budget-configuration). Both local safety gates exercised. |
| `display_name` maximum 128 characters; optional `filter`; alerts list | **docs-verified; live-verified (GET only)** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Public text says exactly one alert, but GET returns one, two, or three. Imports preserve the complete observed list rather than flattening it. Multi-alert writes are fake-client verified only. |
| Filter `workspace_id={operator:"IN", values:[int64...]}`; `tags=[{key,value:{operator:"IN",values:[str...]}}]`; filters ANDed | **docs-verified**, presence **live-verified (GET only)** | [Create schema](https://docs.databricks.com/api/budgets/v1/create-budget-configuration). Tags are case-sensitive. |
| Alert `quantity_threshold` is a string; `MONTH`, `LIST_PRICE_DOLLARS_USD`, `CUMULATIVE_SPENDING_EXCEEDED` | **docs-verified**, enum values **live-verified (GET only)** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Declaration names map to actual wire names. |
| Email actions are `action_configurations=[{action_type:"EMAIL_NOTIFICATION",target:...}]`; beta `BLOCK_USAGE` | **docs-verified**, action shapes **live-verified (GET only)**; empty actions **live-verified (authorized throwaway)** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Email/block actions, per-user overrides, and affected-user notification behavior are preserved. No live notification or enforcement action was configured. |
| No documented description, arbitrary metadata, or managed-marker tag field | **docs-verified** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Filter tags select spending; they cannot safely carry an ownership marker. |
| Beta resource scope / per-user alerts / overrides | **docs-verified**, newer response fields **live-verified (GET only)** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Resource enums ALL_RESOURCES/UNITY_AI_GATEWAY, shared/per-user scope, and `{principal_id, override_threshold}` are round-tripped. |
| Account credential can list/get; workspace credential is not an account credential | **live-verified (GET only)** and previously verified in PR #11 | [SDK authentication](https://databricks-sdk-py.readthedocs.io/en/latest/authentication.html). Reuses explicit account `Config`, never workspace-to-account fallback. |
| Account-wide management needs account admin; workspace admins manage their workspace-scoped budgets | **docs-verified; live-verified (authorized throwaway)** | [Budget permissions/prerequisites](https://docs.databricks.com/aws/en/admin/account-settings/budgets). Same selected account credential: unfiltered create 403, own-workspace-filtered create/update/delete 200. No added grant was required. |
| GET top-level `workspace_id` vs writable `filter.workspace_id` | **live-verified (GET only)** and **live-verified (authorized rejected request/lifecycle)** | [Create filter schema](https://docs.databricks.com/api/budgets/v1/create-budget-configuration). Top-level `workspace_id` is not in the public write schema; sending it returns 400 `INVALID_PARAMETER_VALUE`: "workspace_id is not supported on budget create; scope the budget via its filter." Removing it and retaining the singleton filter succeeds. |
| Billing tables and USD effective-list-price join | **docs-verified**; table metadata **live-verified (GET only)**, both HTTP 200 | [Usage](https://docs.databricks.com/aws/en/admin/system-tables/billing), [Prices](https://docs.databricks.com/aws/en/admin/system-tables/pricing). SQL execution itself remains unverified. |

## Exact workspace-scoped shape

GETs of existing budgets expose this structure (metavariables below are not live IDs):

```python
{
    "workspace_id": CURRENT_WORKSPACE_ID,
    "resource_type": "BUDGET_RESOURCE_TYPE_ALL_RESOURCES",
    "product_type": "BUDGET_PRODUCT_TYPE_ALL_PRODUCTS",
    "pricing_basis": "BUDGET_PRICING_BASIS_LIST_PRICE",
    "include_external_spend": False,
    "filter": {"workspace_id": {"operator": "IN", "values": [CURRENT_WORKSPACE_ID]}},
    "alert_configurations": [{
        "time_period": "MONTH", "quantity_type": "LIST_PRICE_DOLLARS_USD",
        "trigger_type": "CUMULATIVE_SPENDING_EXCEEDED", "quantity_threshold": "1",
        "scope_type": "ALERT_CONFIGURATION_SCOPE_TYPE_SHARED", "action_configurations": [],
    }],
}
```

AI Gateway variants replace both resource/product enum suffixes with UNITY_AI_GATEWAY.
GET also returns resource `name`, IDs, ingestion/backfill timestamps, and alert/action
timestamps. These are metadata, not user-editable selection criteria. The declaration
preserves the resource workspace ID explicitly; if a legacy GET omits it, the single
workspace filter supplies the effective scope. Plan comparisons ignore generated IDs
and top-level workspace metadata but retain every mutable filter/resource/alert field.

The **actual successful write** sends the `budget` envelope with `account_id`,
`display_name`, `filter`, `resource_type`, and full `alert_configurations`. Update also
sends `budget_configuration_id`. It does **not** send top-level `workspace_id`, resource
`name`, product/pricing/external-spend metadata, or server timestamps. Those extra
response fields do not appear in the published create/update schemas. Product scope
must agree with resource scope; list pricing and no external spend are the supported
metadata defaults. Unknown fields, unknown actions, non-list pricing, or external spend
are refused instead of stripped from an actionable import.

All 22 baseline budgets import successfully and produce no-op plans against live GETs;
none were adopted or changed. That includes 20 AI Gateway and two all-resource budgets,
multi-alert/per-user shapes, principal overrides, and email/blocking actions. Only two
baseline budgets target the DEFAULT workspace; reading others never implies permission
or ownership to mutate them. Runtime workspace/account/resource IDs and recipients are
never committed or printed by the smoke.

## Decisions and invariants

- Declarations live only in cell 1. Validation accumulates errors; bad values and
  API response bodies are not echoed. No resource identifiers or recipients ship
  in source. The example is inert until renamed; defaults are dry-run.
- Workspace scope defaults to the current notebook/DEFAULT workspace. The workspace
  filter must equal that resource workspace's singleton ID. Account scope must be
  explicitly selected, cannot silently inherit workspace scope, and requires the
  appropriate account-admin privileges for unfiltered/account-wide management.
- Ownership is the explicit `MANAGED_BUDGET_IDS` registry plus per-entry, ID-specific
  `adopt=True`. Same-name matches cannot authorize changes. A missing explicit ID
  cannot trigger a create. New IDs must be persisted manually in notebook variables.
- Deletions use registry IDs absent from desired declarations, not names/prefixes
  or a broad live scan. They require `apply is True` and `allow_deletes is True`.
- Local auth requires `DATABRICKS_ACCOUNT_PROFILE`; runtime requires account ID and
  interactive consent by default, or an explicitly selected readable account-token
  secret. Runtime account host is allowlisted. The library
  never constructs a workspace client or obtains a workspace token.
- Plan and export make GET requests only. Spark reporting is separate; local smoke
  only inspects metadata with the explicitly selected workspace profile `DEFAULT`.
- Full replacement is intentional. Unsupported shapes fail closed. Snapshot checks
  compare a fresh GET with the planned object before each existing-target mutation.
  Writable live fields are compared directly with desired writable fields before
  update/adopt, and during plan/verification; declaration conversion cannot hide
  duplicate actions. Unchanged adoption is registry-only, with no PUT. Missing
  registered IDs produce visible error rows and never replacement creates.
  Create checks for a new name collision immediately before POST.
- There is no transactional concurrency control or documented idempotency key.
  No library create retries; unknown outcomes require manual inspection/import.
  SDK transport retry policy is bounded, not a distributed exactly-once guarantee.
  Successful writes are GET-verified with bounded retries. Failures are sanitized;
  the notebook stops rather than implying all actions succeeded.
- Import retains IDs and sets `adopt=False`. It emits only safely representable
  entries and the omitted count, never silently discards unsupported alert/filter
  semantics. Do not treat a partial export as a complete deletion manifest.
- Spend uses parameterized SQL and account filtering, USD effective list prices,
  SKU/cloud/unit/time joins, per-month totals, full monthly thresholds, and explicit
  partial-month/unpriced-row flags. It is not an invoice or exact alert-engine replay.
  No mixed-unit quantity sums; missing prices and ingestion latency remain limits.
  Each shared all-resource threshold can be compared; resource-specific/external or
  per-user comparisons print an explicit limitation, not a misleading aggregate.

## Gate state

- Pytest suite (fake API plus real OAuthClient/Config): **127 collected cases,
  127 passed** on isolated **databricks-sdk 0.154.0** and local **0.114.0**.
  The real OAuthClient URL test also passes against **0.67.0**. Both source files
  compile. Ruff checks pass (notebook-injected globals and path imports exempted);
  mypy checks pass (SDK imports skipped, notebook-injected globals exempted).
- Read-only live gate: passed; 22 budgets, plan path and apply-false path executed,
  import emitted a valid Python literal for all 22 and a no-op plan for every entry, both table metadata
  calls HTTP 200. No SQL submission, deployment, or pre-existing-budget mutation.
- Historical baseline (PR #12) authorized workspace-scoped throwaway gate: **passed**, using only account profile
  `budget-account-test` and DEFAULT workspace discovery. Exactly one budget created:
  POST 200; verification GET 200; one PUT 200 and GET-confirmed new amount; DELETE 200
  through `apply_plan(apply=True, allow_deletes=True)` in `finally`; absence-list GET
  200 and direct GET 404. Zero left behind, zero pre-existing budgets mutated.
  This interactive-sign-in change did **not** run that mutating gate; its live
  checks were GET-only. Human OAuth login and report SQL remain untested.
- Earlier rejected attempts created nothing: account-wide POST 403; top-level
  workspace metadata POST 400. The 400 message established the correct filter-only
  write shape; there was no credential/profile change. Mutations are not retried
  after a 403. The smoke prevents transport-level create/update retries.

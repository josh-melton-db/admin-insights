# Budgets notebook specification

This directory mirrors the layout and declare/plan/apply/import/report workflow of
`../usage-policies/`, but uses the account Budgets API and account credentials.
It does not modify the app, other bundles, authentication notebook, or workspace.

## API evidence (2026-10-19)

Official API pages were fetched and their rendered schema inspected. The old
`/api/account/budgets/{create,get,list,update,delete}` URLs redirect to the links
below. The official Python SDK's `billing.BudgetsAPI` independently confirms REST
verbs, paths, envelopes, and full replacement semantics. Docs and live responses
are not identical; only GET shapes can be called live-verified at present.

| Contract | Evidence status | Official source / observations |
|---|---|---|
| POST `/api/2.1/accounts/{account_id}/budgets`, body `{"budget": {...}}`, response `budget` | **docs-verified**; authorized live attempt returned **403**, not verified successful | [Create](https://docs.databricks.com/api/budgets/v1/create-budget-configuration). No budget created. |
| GET `/api/2.1/accounts/{account_id}/budgets/{budget_id}`, response `budget` | **live-verified (GET only)**, HTTP 200 | [Get](https://docs.databricks.com/api/budgets/v1/get-budget-configuration). Read existing budgets only. |
| GET `/api/2.1/accounts/{account_id}/budgets`, response `budgets`, `next_page_token`; query `page_token` | **live-verified (GET only)**, HTTP 200, 22 budgets | [List](https://docs.databricks.com/api/budgets/v1/list-budget-configurations). Pagination mechanics also covered by fake-client tests. |
| PUT `/api/2.1/accounts/{account_id}/budgets/{budget_id}`, body `budget`, full replacement (not PATCH) | **docs-verified**, fake-client apply verified; no live update | [Update](https://docs.databricks.com/api/budgets/v1/update-budget-configuration). Include account and budget IDs plus full desired fields. |
| DELETE `/api/2.1/accounts/{account_id}/budgets/{budget_id}`; irreversible | **docs-verified**, fake-client apply verified; no live deletion | [Delete](https://docs.databricks.com/api/budgets/v1/delete-budget-configuration). Both local safety gates required. |
| `display_name` maximum 128 characters; optional `filter`; exactly one `alert_configurations` entry | **docs-verified** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Some live budgets have multiple alerts; these are refused rather than flattened. |
| Filter `workspace_id={operator:"IN", values:[int64...]}`; `tags=[{key,value:{operator:"IN",values:[str...]}}]`; filters ANDed | **docs-verified**, presence **live-verified (GET only)** | [Create schema](https://docs.databricks.com/api/budgets/v1/create-budget-configuration). Tags are case-sensitive. |
| Alert `quantity_threshold` is a string; `MONTH`, `LIST_PRICE_DOLLARS_USD`, `CUMULATIVE_SPENDING_EXCEEDED` | **docs-verified**, enum values **live-verified (GET only)** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Declaration names map to actual wire names. |
| Email actions are `action_configurations=[{action_type:"EMAIL_NOTIFICATION",target:...}]` | **docs-verified**, action shape **live-verified (GET only)** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Beta `BLOCK_USAGE` is not supported by this notebook. Empty actions remain docs-only, not successful-live-create verified. |
| No documented description, arbitrary metadata, or managed-marker tag field | **docs-verified** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Filter tags select spending; they cannot safely carry an ownership marker. |
| Beta resource scope / per-user alerts / overrides | **docs-verified**, newer response fields **live-verified (GET only)** | [Budget schema](https://docs.databricks.com/api/budgets/v1/budget). Refuse unsupported scopes/actions instead of overwriting them. |
| Account credential can list/get; workspace credential is not an account credential | **live-verified (GET only)** and previously verified in PR #11 | [SDK authentication](https://databricks-sdk-py.readthedocs.io/en/latest/authentication.html). Reuses explicit account `Config`, never workspace-to-account fallback. |
| Account-admin management prerequisite; workspace admins manage workspace-scoped budgets through Governance Hub | **docs-verified**; selected account credential cannot create (403) | [Budget permissions/prerequisites](https://docs.databricks.com/aws/en/admin/account-settings/budgets). Read success does not imply account-level write access. |
| Billing tables and USD effective-list-price join | **docs-verified**; table metadata **live-verified (GET only)**, both HTTP 200 | [Usage](https://docs.databricks.com/aws/en/admin/system-tables/billing), [Prices](https://docs.databricks.com/aws/en/admin/system-tables/pricing). SQL execution itself remains unverified. |

Live GET response differences: additional resource metadata (`name`, `workspace_id`,
ingestion/backfill timestamps), pricing/product/resource-scope and external-spend
fields, alert/action timestamps, and `notify_affected_user`. Known metadata is
accepted only for the supported account-wide/list-price shape. Non-default pricing,
external spend, AI Gateway resources, positive top-level resource workspace scope,
per-user alerts, multiple alerts, user-notification behavior, non-email actions,
and unknown fields are rejected for import/update. Explicit registry deletion is
still allowed intentionally, because it is an explicit deletion authorization,
not a lossy rewrite. Test-account inventory: 20 AI Gateway budgets and two other
workspace-scoped budgets; **zero safely representable exports**, 22 skipped.

## Decisions and invariants

- Declarations live only in cell 1. Validation accumulates errors; bad values and
  API response bodies are not echoed. No resource identifiers or recipients ship
  in source. The example is inert until renamed; defaults are dry-run.
- Ownership is the explicit `MANAGED_BUDGET_IDS` registry plus per-entry, ID-specific
  `adopt=True`. Same-name matches cannot authorize changes. A missing explicit ID
  cannot trigger a create. New IDs must be persisted manually in notebook variables.
- Deletions use registry IDs absent from desired declarations, not names/prefixes
  or a broad live scan. They require `apply is True` and `allow_deletes is True`.
- Local auth requires `DATABRICKS_ACCOUNT_PROFILE`; runtime requires account ID and
  a readable account-token secret. Runtime account host is allowlisted. The library
  never constructs a workspace client or obtains a workspace token.
- Plan and export make GET requests only. Spark reporting is separate; local smoke
  only inspects metadata with the explicitly selected workspace profile `DEFAULT`.
- Full replacement is intentional. Unsupported shapes fail closed. Snapshot checks
  compare a fresh GET with the planned object before each existing-target mutation.
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

## Gate state

- Fake-client pytest suite: **68 collected cases, 68 passed**. Both source files
  compile. Ruff checks pass (notebook-injected globals and path imports exempted);
  mypy checks pass (SDK imports skipped, notebook-injected globals exempted).
- Read-only live gate: passed; 22 budgets, plan path and apply-false path executed,
  import emitted a valid Python literal with 22 explicit skips, both table metadata
  calls HTTP 200. No SQL submission, deployment, or pre-existing-budget mutation.
- Authorized throwaway gate: **blocked** at POST HTTP 403 using
  `budget-account-test`. Exactly one creation attempt; zero budgets created;
  `finally` recovery GET confirmed no matching new budget, so zero left behind.
  Update, successful creation, delete, and post-delete 404 remain unverified.
- PR opening must wait for the authorized lifecycle gate to pass. Do not bypass
  this gate or switch credentials without the user's approval.

# Workspace budgets notebook specification

This directory mirrors the layout and declare/plan/apply/import/report workflow of
`../usage-policies/`, but uses the account Budgets API and account credentials.
It does not modify the app, other bundles, authentication notebook, or workspace.
Primary use case: a workspace admin manages budgets scoped to their own workspace,
using an account-host credential. Account-wide management is an explicit admin-only opt-in.

## API evidence (2026-10-19)

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
  Each shared all-resource threshold can be compared; resource-specific/external or
  per-user comparisons print an explicit limitation, not a misleading aggregate.

## Gate state

- Fake-client pytest suite: **91 collected cases, 91 passed**. Both source files
  compile. Ruff checks pass (notebook-injected globals and path imports exempted);
  mypy checks pass (SDK imports skipped, notebook-injected globals exempted).
- Read-only live gate: passed; 22 budgets, plan path and apply-false path executed,
  import emitted a valid Python literal for all 22 and a no-op plan for every entry, both table metadata
  calls HTTP 200. No SQL submission, deployment, or pre-existing-budget mutation.
- Authorized workspace-scoped throwaway gate: **passed**, using only account profile
  `budget-account-test` and DEFAULT workspace discovery. Exactly one budget created:
  POST 200; verification GET 200; one PUT 200 and GET-confirmed new amount; DELETE 200
  through `apply_plan(apply=True, allow_deletes=True)` in `finally`; absence-list GET
  200 and direct GET 404. Zero left behind, zero pre-existing budgets mutated.
- Earlier rejected attempts created nothing: account-wide POST 403; top-level
  workspace metadata POST 400. The 400 message established the correct filter-only
  write shape; there was no credential/profile change. Mutations are not retried
  after a 403. The smoke prevents transport-level create/update retries.

# Account budgets notebook

Account budgets as code in one Databricks source-format notebook, following
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

**Databricks runtime:** supply the account ID and the scope/key of an existing secret
containing an **account-host bearer token**. The caller needs permission to read that
secret. The runtime constructs `Config(host=account_host, account_id=..., token=...,
auth_type="pat")`; it never asks the notebook workspace for its token. Provision and
rotate secrets through your normal secure process, never in notebook source/output.

Read permission is not write permission. An account-admin or appropriate budget
management permission is needed for account-level creation/management. Workspace
admin access alone does not establish that permission. Our selected account profile
can read budgets but its isolated creation request returned HTTP 403 (see SPEC).
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

Edit the first declaration cell and run all. Validation collects every declaration
and date-range error **before any API call**. Never share private import-cell output
or commit runtime IDs, emails, hosts, tokens, or exported live configuration.

| Widget | Default | Meaning |
|---|---|---|
| `apply` | `false` | Enables mutations only when `true`. |
| `allow_deletes` | `false` | Deletion also requires this to be `true`. |
| `account_id` | empty | Runtime requirement; optional local profile override. |
| `account_host` | public AWS accounts host | Runtime accounts host; AWS, Azure, and GCP accounts hosts are allowlisted. Local host comes only from the selected profile. |
| `account_token_secret_scope` | empty | Runtime account-token secret scope. |
| `account_token_secret_key` | empty | Runtime account-token secret key. |
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
  declares no notification actions; actual API acceptance is not yet live-verified.
- `name`: unique, nonblank, maximum 128 characters. `amount`: finite, strictly
  positive numeric value, serialized as a decimal string.
- Exactly one alert is supported, matching the documented account API. The only
  supported period, quantity, trigger, and action types are those shown above
  and `EMAIL_NOTIFICATION`; they are not arbitrary enums.
- Optional `workspace_ids`: nonempty list of positive int64 IDs; omit for all
  workspaces. Optional `tags`: case-sensitive keys mapping to nonempty lists of
  allowed values. Filters combine with AND; alternatives within one filter use IN.
- Optional `budget_id`: identifies an existing budget, independent of its name.
  Optional `adopt=True`: explicit authorization to manage that particular ID.

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
   desired budget object, including the ID and account ID. Field-level diffs list
   changed field names without printing recipients or IDs.
5. After a create/adopt, copy its ID from import into both its declaration and the
   ownership registry for subsequent runs. There is no hidden durable state.
6. To delete, remove its declaration **but retain its ID in the registry**. The
   resulting delete requires both `apply=true` and `allow_deletes=true`. Remove
   its registry ID after confirming deletion. Empty declarations never sweep
   all live budgets; only explicitly registered IDs can be deleted.

Live reads can expose newer AI Gateway, per-user, workspace-resource, or multi-alert
budget shapes beyond the documented account schema. We refuse lossy import/update
of these objects and report the skipped count instead. Unknown fields are not
silently stripped. **An export is not a complete account inventory** when skips
are reported; do not use it as a deletion manifest. In the current test account all
22 budgets are scoped and are therefore skipped by the supported-schema export.

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
Only one supported list-price USD threshold is reported per budget. Newer scoped,
per-user, and blocking-budget semantics are deliberately not approximated.

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
apply path, with a unique tag filter and no recipients, then verifies, updates once,
and deletes through the apply path with both gates. A guard refuses mutation of
any other ID, and `try/finally` cleanup recovers only that unique newly created name.
This gate currently fails at creation with HTTP 403 and leaves no budget behind.
Do not change profiles or broaden permissions automatically to bypass the failure.

# Local account budgets as code

Run from the repository root with Python 3.10+. Account budget calls use an
explicit Databricks CLI account profile; workspace credentials are used only to
discover the account ID and default workspace scope, and execute optional spend reports.

## Setup and run

Sign in once with the CLI (substitute your account ID and chosen profile names):

```bash
databricks auth login --host https://accounts.cloud.databricks.com --account-id <ACCOUNT_ID> --profile <ACCT_PROFILE>
python -m pip install -r bundles/budgets/requirements.txt
python bundles/budgets/src/manage_budgets.py --help
python bundles/budgets/src/manage_budgets.py --account-profile <ACCT_PROFILE> --workspace-profile <WS_PROFILE>
```

Use the accounts host for your cloud. A workspace profile cannot authenticate
account budget requests. Authentication failures print a login command, never
credentials or API error bodies. No pasted codes or platform secrets are needed.

With `--workspace-profile`, the CLI discovers the account ID from the workspace
SDK configuration (falling back to workspace metadata) and fills the login hint
automatically, including the cloud's accounts host when known. To look it up manually:

```bash
databricks api get /.well-known/databricks-config --profile <WS_PROFILE> | jq -r .account_id
```

Discovery requires no account-admin rights and does not grant account access.
If it fails, the CLI keeps the placeholder and prints the lookup command; an
otherwise valid account profile still works. If the discovered ID differs from
the account profile's ID, the CLI stops before any budget request. Workspace
credentials are never reused for account budget requests.

Edit `BUDGETS` and `MANAGED_BUDGET_IDS` at the top of
`src/manage_budgets.py`. The shipped `example-*` declaration is plan-only:
rename/replace it before applying. There is no separate configuration file.

The default action validates and prints a read-only plan. Mutations require
`--apply`; deletion additionally requires `--allow-deletes`:

```bash
python bundles/budgets/src/manage_budgets.py --account-profile <ACCT_PROFILE> --workspace-profile <WS_PROFILE> --apply
python bundles/budgets/src/manage_budgets.py --account-profile <ACCT_PROFILE> --workspace-profile <WS_PROFILE> --import
```

`--import` prints live declarations after planning (or after applying, if requested).
Its output contains private configuration: treat it accordingly. It retains IDs
and sets `adopt=False`; unsupported/unreadable budgets are counted as skipped.
Never use a partial export as a complete deletion manifest.

## Scope and ownership

- Default scope is the workspace selected by `--workspace-profile`; use
  `--workspace-id` to override its ID or work without a workspace client.
  A default workspace-scoped declaration needs one of these explicit inputs.
- Workspace scope writes `filter.workspace_id` with exactly that singleton ID,
  not a top-level workspace write field. For account scope, explicitly declare
  `scope="account"`; `workspace_ids=None` means whole-account spend.
- Existing budgets are managed only by IDs in `MANAGED_BUDGET_IDS` or explicit
  per-entry `budget_id` plus `adopt=True`. A matching name never authorizes writes.
- Unchanged adoption does not rewrite. After create/adopt, persist the ID in its
  declaration and the registry. There is no hidden durable ownership state.
- To delete, remove the declaration but retain its registry ID, inspect the plan,
  then pass both `--apply --allow-deletes`. Remove the ID after confirmed deletion.
  Empty declarations cannot sweep unregistered live budgets.
- Missing registered IDs appear as plan errors, never replacement creates.
  Plan errors block apply; failed/unconfirmed results exit nonzero and stop later
  import/report actions. Validation, authentication, and report failures also fail.

Updates are full replacements. Unsupported shapes fail closed. A fresh GET must
match the planned snapshot before an existing-target mutation. Live and desired
writable fields are compared directly; normalization never discards duplicate
actions. Creates recheck name collisions immediately before POST. There is no
transactional compare-and-swap or documented create idempotency key: do not run
concurrent writers. Writes use bounded GET verification. A failed create may have
succeeded remotely: inspect/import before retrying; never blindly repeat creates.
Deletion is irreversible.

## Spend report

```bash
python bundles/budgets/src/manage_budgets.py --account-profile <ACCT_PROFILE> --workspace-profile <WS_PROFILE> --report --warehouse-id <WAREHOUSE_ID> --start-date 2026-09-01 --end-date 2026-10-01
```

Reporting uses the workspace SQL Statement Execution API and requires warehouse
access and SELECT on `system.billing.usage` and `system.billing.list_prices`.
Dates default to the last 30 days, inclusive start and exclusive end. Results
print as plain tables; asynchronous execution is polled for up to five minutes,
then a timed-out statement is cancelled before returning an error;
all result chunks are read, and failed/truncated results exit nonzero. Reporting
is opt-in and can start warehouse compute; it never writes budgets without
`--apply`.

The parameterized query filters the account, workspace IDs, and case-sensitive
tags, joining USD effective list prices by SKU/cloud/unit/time. It reports monthly
estimated list cost, the full monthly threshold, percent used, overage,
partial-month flags, and unpriced row counts. It is not an invoice or exact alert
replay: discounts, credits, taxes, ingestion delays, external spend, and corrections
may differ. Partial months are not prorated. Missing prices mean incomplete
costs, not confirmed underspend. No usage yields no monthly row. Unsupported
resource-specific/external or per-user comparisons fail explicitly rather than
presenting a misleading aggregate.

## Validation

```bash
python -m pytest bundles/budgets/tests -q
python -m py_compile bundles/budgets/src/*.py
grep -nE "dbutils|displayHTML|OAuthClient|MAGIC|COMMAND" bundles/budgets/src/*.py
python bundles/budgets/src/manage_budgets.py --account-profile budget-account-test --workspace-profile DEFAULT
```

Unit tests use a fake account API, never live credentials. The last command is the
explicitly authorized read-only live gate: do not add `--apply`. The historical
`tests/live_smoke.py` is a separate opt-in diagnostic and is not required for local
CLI use; never run its mutating `--throwaway` mode without separate authorization.

# Budgets local CLI contract

## Execution

Declarations and the explicit ownership registry live at the top of
`src/manage_budgets.py`. The entry point is ordinary local Python with argparse,
not a hosted notebook. Install `databricks-sdk>=0.154.0` from `requirements.txt`.

Required `--account-profile` is passed directly to `AccountClient(profile=...)`.
Its configuration must have an allowlisted HTTPS accounts host and account ID.
Initialization or plan-read authentication failures return nonzero and print the
CLI account-login command without underlying exception bodies or credentials.
`--workspace-profile` explicitly selects `WorkspaceClient` for workspace-ID
discovery and reporting; `--workspace-id` overrides discovery. Profiles are never
auto-selected. No runtime/secret/interactive authentication branches remain.

Run order: validate declarations/registry, plan, apply only with `--apply`, export
only with `--import`, report only with `--report`. Default budget calls are GET-only.
`--allow-deletes` without `--apply` cannot mutate. `--report` requires both
`--warehouse-id` and `--workspace-profile`; dates are validated before writes.
Validation errors, plan errors with apply, failed/unconfirmed writes, auth errors,
and report failures return nonzero. Argparse usage errors return 2.

## Safety invariants

- Workspace scope defaults to the explicitly selected workspace and writes a
  singleton `filter.workspace_id`. Whole-account scope is explicit, never inferred.
- Managed existing budgets require explicit registry IDs or ID-specific adoption.
  Names cannot authorize mutation; missing IDs never trigger replacement creates.
- Deletions target only registered IDs absent from desired declarations and require
  both flags. Empty desired state cannot sweep unrelated budgets.
- `example-*` declarations are refused on apply. Validation accumulates sanitized
  errors; shipped source contains no account/workspace IDs or recipients.
- Full replacement fails closed on unsupported shapes. Live-vs-desired writable
  comparison preserves duplicate actions, normalizing only harmless defaults and
  metadata. No-op adoption is registry-only and does not issue PUT.
- Every existing-target write rechecks its snapshot; creates recheck collisions.
  GET verification is bounded. There is no transactional isolation or create
  idempotency guarantee; failed/unconfirmed outcomes require import before retry.
- Export preserves IDs with `adopt=False`, counts skipped unsupported entries,
  and must not be treated as a complete deletion manifest when skips occur.

## Reporting

`budgets_lib.report_query` supplies parameterized SQL to the workspace Statement
Execution API. Named parameters are sent as SDK statement parameters. Pending
statements are polled with a five-minute deadline; all inline chunks are printed
as a plain table. Failed, timed-out, missing, or truncated results fail nonzero.
Dates default to [today minus 30 days, today). SQL execution is opt-in and may
start warehouse compute; it is separate from budget mutations.

Spend is estimated USD list cost with account/workspace/tag filtering, effective
SKU/cloud/unit/time price joins, full monthly thresholds, partial-month and
unpriced-row flags. It is not an invoice or exact alert-engine replay. Unsupported
per-user/resource-specific/external attribution fails explicitly.

## Verification gates

- Fake-client pytest covers CLI flags, auth errors, validation, plan/apply/delete
  safety, import, statement polling/chunks, report failures, and library invariants.
- Run the suite with the installed SDK and 0.154.0 in a fresh virtual environment.
- Compile all source files, check obsolete notebook/auth markers are absent, and
  inspect `--help`.
- Run the local CLI read-only with `--account-profile budget-account-test
  --workspace-profile DEFAULT`. Never add apply or mutate live resources.
- Live SQL execution is not part of the read-only gate; report tests use fake
  statement responses. CLI sign-in itself is performed by the user, outside the tool.

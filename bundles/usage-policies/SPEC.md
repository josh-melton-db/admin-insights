# SPEC: Serverless usage policies as code (notebook)

## Goal

A workspace admin, who is NOT an account admin, declares serverless usage
policies (projects and cost centers) as code in one Databricks notebook, sees a
plan, applies it, and reports chargeback spend by policy and tag. There is no
CLI and no DAB resource. The notebook gives the bundle-like workflow
(declare, then plan, then apply).

## Decisions (agreed with the user)

- The deliverable is a Databricks notebook, not a CLI. Packaging as a CLI or
  DAB resource is left to Databricks engineering.
- Policies are declared as Python variables in a notebook cell. Do not use
  YAML or JSON config files (user rule: variables over file configs).
- The notebook runs as the notebook user's own workspace credentials. It uses
  `WorkspaceClient()` and raw REST through `w.api_client.do`. It must not use
  the account host, `AccountClient`, or account-admin credentials.
- Do not commit any workspace host, workspace ID, account ID, or user email.
  Discover them at runtime. (PR #3 removed these identifiers from the repo.)
- Location: `bundles/usage-policies/`, next to `apps-monitoring`.

## Verified API contract (workspace host, workspace-admin token, probed live)

Let `B = /api/2.0/serverless-policies`.

| Op | Call | Notes |
|----|------|-------|
| Create | `POST B` with body `{"policy": {policy_name, custom_tags:[{key,value}], binding_workspace_ids:[int]}, "request_id": "<uuid>"}` | The response is the unwrapped policy, including `policy_id`. Replaying the same `request_id` is idempotent. A duplicate name returns 409 `ALREADY_EXISTS`. |
| Get | `GET B/{id}` | Includes `creator_user_name`. Returns 403 `PERMISSION_DENIED` without the use permission, and 404 `NOT_FOUND` once deleted. |
| List | `GET B?page_size=N[&page_token=..][&filter_by.policy_name=..]` | Returns `{"policies":[...], "next_page_token"}`. An empty result serializes as `{}`. Only policies the caller can see are listed. |
| Update | `PATCH B/{id}` with a FLAT body `{policy_name, custom_tags, binding_workspace_ids}` | `policy_name` is always required. Without `update_mask`, omitted fields are CLEARED, so always send the full desired object. Tags replace wholesale. Rename works. PUT returns 404. |
| Delete | `DELETE B/{id}` | Returns 200 `{}`. |
| Read grants | `GET /api/2.0/preview/accounts/access-control/rule-sets?name=accounts/{account_id}/budgetPolicies/{id}/ruleSets/default&etag=` | Returns `{name, etag, grant_rules:[{principals:[...], role}]}`. |
| Write grants | `PUT /api/2.0/preview/accounts/access-control/rule-sets` with body `{"name": N, "rule_set": {"name": N, "etag": E, "grant_rules": [...]}}` | REPLACES all rules. Use the etag from the latest GET. |

- Roles: `roles/budgetPolicy.user` (can use the policy) and
  `roles/budgetPolicy.manager` (can edit it and its grants).
- Principals: `users/<email>`, `groups/<name>`, and
  `servicePrincipals/<applicationId>`. Groups must be ACCOUNT groups. The
  workspace-local `users` group returned 400 "Group users not found".
- Limits: at most 20 custom tags (more returns 400). Validate locally anyway:
  enforce the 20-tag limit, unique keys, non-empty names of at most 127
  characters, tag values of at most 256 characters, and reject the
  documented-reserved keys `budget-policy-name`, `budget-policy-id`, and
  `budget-policy-resolution-result`. The server accepts the reserved keys,
  but the docs reserve them.
- Eventual consistency: reads can be stale for a short time after
  create, update, or delete. Re-reads after apply must poll with a bounded
  retry and backoff, and must not assume immediate read-after-write.

Chargeback data: `system.billing.usage` is queryable as a workspace admin.
Policy tags appear in `custom_tags` (a map). The policy ID appears in
`usage_metadata.usage_policy_id` and `usage_metadata.budget_policy_id`.
`system.billing.list_prices` is available for a list-price estimate. No system
table lists policies, so map policy IDs to names through the List API.

## Deliverable

```
bundles/usage-policies/
  README.md                       how to import, run, and declare policies
  SPEC.md                         this file
  src/usage_policies_lib.py       pure logic + thin API client (importable, unit-tested)
  src/manage_usage_policies.py    Databricks notebook (source format, "# Databricks notebook source")
  tests/test_usage_policies_lib.py
```

The notebook imports the lib from its own directory. On serverless notebooks,
workspace files in the same folder are importable. Keep the notebook thin:
declarations, widgets, calls into the lib, and display output.

### Notebook cells

1. **Declare.** `REQUIRED_TAG_KEYS = ["cost_center", "project", "owner"]` and
   `POLICIES = [...]`. Each entry is a dict or dataclass with `name`, `tags`
   (dict), optional `workspace_ids` (defaults to the current workspace;
   `"all"` means an empty binding, i.e. every workspace), `users` (principals
   that get the User role), and `managers` (principals that get the Manager
   role). Ship two clearly fake example policies.
2. **Widgets.** `apply` (false/true, default false), `allow_deletes`
   (false/true, default false), `chargeback_start_date` and
   `chargeback_end_date` (default: the last 30 days), and an optional
   `account_id` override.
3. **Validate.** Local validation as described above, including required tag
   keys. Fail fast and list every error.
4. **Plan.** Diff the declared policies against live state. Show a readable
   table with these actions: `create`, `update` (field-level diff),
   `grants` (principals added or removed per role), `delete`, and `no-op`.
5. **Apply.** Runs only when `apply=true`. Executes the plan, then re-reads
   with retry and prints the final state. Creates use a deterministic
   `request_id` per run so a retried cell does not duplicate.
6. **Import.** Prints the policies the caller can see, as a ready-to-paste
   `POLICIES` Python literal, so existing policies can be adopted.
7. **Chargeback.** Spend for the date range from `system.billing.usage`,
   joined to `list_prices` for an estimated list cost. Show it grouped by
   policy (name via the API), by each required tag key, and by day. Display
   the result with `display()`.

### Ownership and safety rules

- **Managed marker.** Every policy the notebook creates or adopts carries the
  tag `managed_by=usage-policies-notebook`. This tag counts toward the
  20-tag limit and is added automatically. Users do not declare it.
- **Matching.** A declared policy matches a live policy by exact
  `policy_name`. A live policy with the same name but WITHOUT the marker is
  shown as `adopt` in the plan. Applying it adds the marker plus the declared
  fields, so `import` followed by `apply` adopts an existing policy.
- **Deletes.** `delete` is planned only for live policies that HAVE the
  marker and are absent from `POLICIES`. It executes only when both `apply`
  and `allow_deletes` are true. Unmarked policies are never deleted or
  modified unless declared.
- **Grants.** Grants are authoritative for the two budgetPolicy roles on
  declared policies. Never remove the current caller's Manager grant (that
  would lock the admin out), and say so in the plan output. Preserve any
  grant rules for other roles unchanged.
- **Errors.** A 403 on one policy is reported per policy and does not abort
  the others. A failed apply step reports what succeeded and what did not.
- **Account ID.** Discover the account ID at runtime without account
  credentials. Find a reliable method and document it. The `account_id`
  widget overrides it.

## Acceptance checks

1. `python3 -m pytest -q bundles/usage-policies/tests/` passes. Tests mock
   `api_client.do` and must cover:
   - validation errors
   - plan for each action: create, update with field diff, adopt, grants,
     delete, no-op
   - delete only with the marker, and only with `allow_deletes`
   - the caller's Manager grant is never removed
   - PATCH sends the full flat body with `policy_name`
   - create sends the nested body with `request_id`
   - list pagination, including the empty `{}` response
   - per-policy 403 isolation
   - retry on stale read-after-write
2. The notebook source parses (`python3 -m py_compile`). It contains no
   hardcoded host, workspace ID, account ID, or email.
3. **Live end-to-end** on `--profile DEFAULT`. The user approved creating
   test policies; names must start with `zz-foreman-e2e-`.
   1. Drive the lib locally with `WorkspaceClient(profile="DEFAULT")`
      (env `DATABRICKS_CONFIG_PROFILE` is set to something else, so override
      it explicitly).
   2. Run declare → plan → apply (create) → change a tag and add a User
      grant for the caller → plan shows update → apply → plan shows only
      `no-op` → remove from `POLICIES` → apply with `allow_deletes` →
      verify the policy is gone.
   3. Afterwards, list and confirm that no `zz-foreman-e2e-` policy remains.
   4. Paste the transcript in the PR.
4. **Live notebook run.** Import the `src/` folder to the caller's workspace
   home (`databricks workspace import-dir`, profile DEFAULT, under a scratch
   folder). Run the notebook once on serverless with `apply=false` (for
   example via `databricks jobs submit` with a one-time notebook task). It
   must succeed through validate, plan, import, and chargeback. Report the
   run URL. Remove the scratch folder afterwards.
5. `README.md` explains:
   - how to import and run the notebook
   - how to declare and adopt policies
   - the safety rules
   - the permissions involved (workspace admin can create; account groups
     only; Billing admin is needed to see all account policies)
   - that the API is the undocumented-but-CLI-used
     `/api/2.0/serverless-policies` route, so it may change

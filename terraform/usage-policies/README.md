# Serverless usage policies with Terraform

Terraform counterpart of [`bundles/usage-policies`](../../bundles/usage-policies/README.md).
This manages serverless cost-attribution tags and User/Manager grants, not
spending limits, budget alerts, or policy assignment to jobs. The notebook and
its chargeback report remain unchanged.

## Provider level and permissions

Pinned to `databricks/databricks` **1.138.0**, matching `terraform/budgets`.
Terraform **>= 1.9.0** is required for cross-variable input validation and mock
tests, rather than the budgets example's >= 1.5.0 floor.

| Resource | Verified provider support | This module |
| --- | --- | --- |
| `databricks_budget_policy` | **Account only** | Account host and chosen account profile |
| `databricks_access_control_rule_set` | Account **or** workspace proxy | Same account provider, `api = "account"` |

**Account-level credentials are required. This is not a drop-in replacement for
a workspace-admin-only login.** The notebook uses workspace proxy routes that
the budget-policy Terraform resource does not expose. An account host/profile
chooses the login endpoint; it does **not** grant the account-admin role.
Use a principal authorized to create account budget policies and with Manager
permission on each existing policy whose definition/grants it will manage.
The account Billing admin role is required to view/manage all policies; otherwise
visibility is limited to policies the principal can access. An account admin can
arrange the necessary account access/delegation. A workspace-admin role alone
does not establish authorization for this account API: confirm it with your
account administrator, or keep using the notebook if account access is unavailable.
No live authorization or delegated-role combinations were tested here.
Groups in grants must be **account groups**, not workspace-local groups.

Schema evidence (version-pinned upstream docs/source):

- [Budget policy resource](https://github.com/databricks/terraform-provider-databricks/blob/v1.138.0/docs/resources/budget_policy.md):
  `policy_name`, `custom_tags = [{ key, value }]`, `binding_workspace_ids`,
  computed `policy_id`; import ID is the policy ID alone.
- [Budget policy implementation](https://github.com/databricks/terraform-provider-databricks/blob/v1.138.0/internal/providers/pluginfw/products/budget_policy/resource_budget_policy.go):
  create/read/update/delete call `GetAccountClient()`.
- [Rule-set resource](https://github.com/databricks/terraform-provider-databricks/blob/v1.138.0/docs/resources/access_control_rule_set.md)
  and [implementation](https://github.com/databricks/terraform-provider-databricks/blob/v1.138.0/permissions/resource_access_control_rule_set.go):
  dual-level support, `name`, `api`, repeated `grant_rules` blocks containing
  `role` and a set of `principals`. Empty rules clear the rule set.
- [Usage-policy permissions](https://docs.databricks.com/aws/en/admin/usage/budget-policies#serverless-usage-policy-permissions).

The installed provider schema was also checked without authentication using
`terraform providers schema -json` after initialization.

## Login and usage

Choose the profile yourself; none is inferred or defaulted. Login uses the
accounts endpoint for your cloud (AWS default shown; Azure/GCP account hosts are
also accepted by `account_host`). Real values belong only in ignored local files.

```sh
databricks auth login --host https://accounts.cloud.databricks.com --account-id <ACCOUNT_ID> --profile <CHOSEN_ACCOUNT_PROFILE>
cp terraform/usage-policies/terraform.tfvars.example terraform/usage-policies/terraform.tfvars
```

Edit that local file with your explicit `account_id`, `account_profile`, workspace
IDs and principals. The committed example contains only synthetic fixtures.
Ensure the profile matches the host/account; do not rely on ambient credentials
overriding your choice.

```sh
terraform -chdir=terraform/usage-policies init
terraform -chdir=terraform/usage-policies plan
terraform -chdir=terraform/usage-policies apply
```

Review the plan and interactive apply confirmation; do not auto-approve. These
are operator instructions, not commands executed as part of verification.

## Declaration mapping

`policies` defaults to `{}`. It is a map of policy objects keyed by stable
Terraform identity, independent of display names. Preserve keys or use `moved`
blocks when renaming keys.

| Field | Meaning |
| --- | --- |
| `name` | Required unique display name, 1–127 characters |
| `tags` | Required string map, at most 20 entries; values <=256 characters |
| `workspace_ids` omitted/null | Use explicit `default_workspace_id`; fail validation if unavailable |
| `workspace_ids = "all"` or `[]` | Every workspace in the account |
| `workspace_ids = [1, 2]` | Explicit positive int64 workspace IDs |
| `users`, `managers` | Optional principal collections, default empty; `users/…`, `groups/…`, `servicePrincipals/…` |

The account provider has no current workspace to discover. This module requires
an explicit fallback workspace when bindings are omitted, rather than silently
turning a workspace-scoped declaration into account-wide access.
`required_tag_keys` defaults to `cost_center`, `project`, `owner`; each must have
a nonempty value. Reserved budget-policy keys and case-insensitive duplicate tag
keys are rejected. Names must also meet the API's Latin-1 and reserved-prefix
restrictions; these remain service-side checks.

**Terraform type-system caveat:** the semantic input is a map of objects with
`name: string`, `tags: map(string)`, optional `users/managers: set(string)` and
`workspace_ids: "all" | list(number) | null`. Terraform has no union type, and
even `map(object({ workspace_ids = optional(any), ... }))` rejects a map mixing
`"all"` with lists because it cannot infer a common element type. The variable
uses `any` with structural/field validations plus normalization, intentionally
preserving the notebook's mixed binding syntax. Unknown policy fields are
rejected instead of being silently discarded by typed-object conversion.

The notebook's `managed_by=usage-policies-notebook` tag is **not** inserted:
Terraform state is the ownership registry. Do not add that marker to new policies
or manage the same policy from both tools. Imported notebook policies need to be
removed from notebook management before Terraform owns them.

### Grants are authoritative; prevent lockout

Each policy gets exactly one rule set at
`accounts/<account_id>/budgetPolicies/<policy_id>/ruleSets/default` with
`roles/budgetPolicy.user` and `roles/budgetPolicy.manager` rules.
**Grants REPLACE all rules on that rule set**, including undeclared roles or
principals; empty lists remove that role and two empty lists clear all rules.
Importing does not preserve undeclared grants on subsequent apply.
Unlike the notebook, Terraform does not automatically retain the caller's direct
Manager grant or unrelated roles. Explicitly retain the applying principal (or
an appropriate account group) in `managers` before applying. Otherwise it can
lose permission to refresh, change or delete the policy. The checked-in example
uses a synthetic manager group; replace it with an authorized real group locally.

## Adopt existing policies

First declare the existing name, all intended tags, bindings and grants under a
stable key. Then add temporary import blocks (synthetic placeholders shown):

```hcl
import {
  to = databricks_budget_policy.this["example_data_eng_project"]
  id = "example-existing-policy-id"
}

import {
  to = databricks_access_control_rule_set.this["example_data_eng_project"]
  id = "accounts/00000000-0000-0000-0000-000000000001/budgetPolicies/example-existing-policy-id/ruleSets/default"
}
```

Run `plan`, reconcile every proposed difference, then `apply` to adopt. Remove
the temporary import blocks afterward. Policy import uses only the policy ID
(unlike budgets' compound ID); rule-set import uses the full name. Remove the
notebook marker during the handoff, disable notebook writes for these policies,
and do not run both managers concurrently.

Deletion is intentional: remove the entry from `policies`, review the destroy
plan, then apply. Terraform removes its rule set before deleting the policy;
rule-set destruction clears grants. An empty map destroys previously managed
policies, while it creates nothing in a fresh state. The notebook's
`allow_deletes` switch is replaced by Terraform's reviewed plan and confirmation.

## State and reporting

This example uses **local state**, not a remote backend. State/plan files can
contain policy names, tags, identifiers and principals; keep them private and
never commit them. Losing state does not delete remote policies; restore/import
before proceeding. For team use, configure an appropriately secured remote
backend with locking before sharing ownership.

Terraform replaces the notebook's custom validate/plan/apply/import and managed
marker logic with input checks, resource diffs, state and import blocks. It does
not reproduce caller-preservation, ownership rechecks, per-policy partial-success
tables or the notebook's bounded post-write convergence verification. These
resources are preview APIs; review plans after propagation settles.

Terraform does **not** run chargeback SQL. Continue using cell 7 of
[`manage_usage_policies.py`](../../bundles/usage-policies/src/manage_usage_policies.py)
and `chargeback_sql("policy" | "tag" | "day")` in
[`usage_policies_lib.py`](../../bundles/usage-policies/src/usage_policies_lib.py).
It joins `system.billing.usage` to `system.billing.list_prices` with date/currency
filters, retaining usage units; the result is list-price estimated spend, not
negotiated invoice cost. SQL/system-table access remains a separate permission.

## Offline verification

```sh
terraform -chdir=terraform/usage-policies fmt -check -recursive
terraform -chdir=terraform/usage-policies init -backend=false
terraform -chdir=terraform/usage-policies validate
terraform -chdir=terraform/usage-policies test
terraform -chdir=terraform/usage-policies test -test-directory=example-tests -var-file=terraform.tfvars.example
```

Tests use a **mock provider**, synthetic IDs and no Databricks credentials/API
calls. The bindings/grants run uses mock `command = apply` solely to resolve
computed policy IDs and assert the full rule-set name; it never contacts a live
environment. Other runs plan only. Negative cases include reserved/missing tags,
tag limits, malformed principals, duplicate/invalid names and invalid workspace
scope. The example-tests command checks the actual example var file without
overwriting private tfvars. No live plan, import, apply or chargeback query was
run for verification.

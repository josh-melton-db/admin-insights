# Account budgets with Terraform

Standalone alternative to `bundles/budgets/src/manage_budgets.py`. The Python
deployer is unchanged. Terraform owns only resources in its state, never budgets
merely sharing a display name. Start with the empty default `budgets = {}`.
Budgets notify about spending; these all-resource budgets do not cap spending.

## Setup and use

Requires Terraform >= 1.5 (>= 1.7 for the offline mock tests) and an authorized
Databricks account profile. Choose the profile yourself; none is defaulted or
discovered from a workspace. Account ID and profile are required inputs.

From the repository root, sign in interactively yourself:

```sh
databricks auth login --host <ACCOUNTS_HOST> --account-id <ACCOUNT_ID> --profile <CHOSEN_ACCOUNT_PROFILE>
cp terraform/budgets/terraform.tfvars.example terraform/budgets/terraform.tfvars
```

Replace both placeholders in the private tfvars file and replace the shipped
`example-*` declaration before using it against your account. The example has
**explicit account scope** filtered by an example project tag, no workspace IDs,
and no notification recipients. Supply your intended recipients to receive email.
For a cloud other than AWS, set `account_host` to the appropriate HTTPS accounts
host (Azure: `https://accounts.azuredatabricks.net`, GCP:
`https://accounts.gcp.databricks.com`). AWS defaults to
`https://accounts.cloud.databricks.com`.

```sh
terraform -chdir=terraform/budgets init
terraform -chdir=terraform/budgets plan
terraform -chdir=terraform/budgets apply
```

These are user-run live commands, not verification gates. Review the plan before
confirming any apply. Alternatively pass `-var account_profile=<CHOSEN_PROFILE>`
and `-var account_id=<ACCOUNT_ID>` explicitly. Ensure the chosen profile matches
the account and host; do not rely on ambient credentials overriding your intent.
Never commit secrets or real IDs, recipients, tfvars, state, or saved plans.

## Declaration mapping

`budgets` is a map keyed by stable Terraform identity. Changing a key changes the
resource address; preserve keys or use a Terraform `moved` block when renaming.

| Input | Meaning |
| --- | --- |
| `name`, `amount` | Display name (unique, 1–128 characters), positive monthly USD list-price threshold |
| `time_period`, `quantity_type` | `MONTH`, `LIST_PRICE_DOLLARS_USD` (defaults and only supported values) |
| `notification_emails` | Set of email recipients; default empty, so no email actions |
| `tags` | Map of case-sensitive tag keys to nonempty sets of allowed values; `IN` filters |
| `scope = "workspace"` | Default; requires a positive integer `workspace_id`; never discovers or infers one |
| `scope = "account"` | Explicit account scope; optional nonempty `workspace_ids` narrows spend to those workspaces |

Workspace scope forbids `workspace_ids`; account scope forbids `workspace_id`.
Whole-account spend requires explicit account scope with no workspace list.
Workspace IDs are written only to `filter.workspace_id.values`, not a top-level
resource field. Tags combine with the workspace filter. Each budget has one shared
monthly `CUMULATIVE_SPENDING_EXCEEDED` alert and one `EMAIL_NOTIFICATION` action
per recipient. This module covers basic monthly declarations, not advanced
per-user overrides, multiple alerts, AI Gateway, or usage-blocking actions.

The provider is pinned to `databricks/databricks` **1.138.0** (major 1).
The real installed provider schema was inspected using:

```sh
terraform -chdir=terraform/budgets init -backend=false
terraform -chdir=terraform/budgets providers schema -json
```

Source documentation for that exact version:
<https://github.com/databricks/terraform-provider-databricks/blob/v1.138.0/docs/resources/budget.md>.
The schema confirms nested `alert_configurations`, `action_configurations`,
`filter.workspace_id`, and `filter.tags.value` blocks. The resource is account-only
and the budget API is public preview. Commit `.terraform.lock.hcl` for reproducible
provider selection; update it deliberately together with the pinned version and
rerun the offline gates. `init` downloads plugins but does not access an account.

## Adopt existing budgets by ID

Do not let both tools manage the same budget. Stop Python writes first. For each
entry in Python's `MANAGED_BUDGET_IDS` (or another explicitly selected budget ID),
add a matching declaration under a stable key and a temporary `imports.tf` inside
this directory:

```hcl
import {
  to = databricks_budget.this["existing_team"]
  id = "<ACCOUNT_ID>|<BUDGET_CONFIGURATION_ID>"
}
```

The provider requires the **account ID and budget ID separated by `|`**, not the
display name or bare budget ID. Import blocks require Terraform >= 1.5. Run plan,
check the exact target and every proposed change, then apply only after approval.
Import does not infer matching configuration: mismatches can update the budget
in the same apply. Remove the temporary import file after successful adoption;
never commit live IDs. `budget_ids` outputs configuration IDs by key; the import
identifier is the composite form above. Inspect/import a possibly successful
create before retrying after a failure. Never blindly repeat creates.

## Deletion, state, and safety differences

Delete a managed budget by removing its map entry, reviewing plan, then applying.
Deleting an account budget is irreversible (recreating it gives it a new ID).
An empty map can delete **all budgets already tracked in this state**, but cannot
sweep unrelated budgets. Do not erase state to remove a declaration. Never run
concurrent writers or share ownership with the Python deployer.

State is **local by default** and contains private configuration including IDs,
tags and recipients. Keep it secure and backed up. For teams, configure a secure
remote backend with access control, encryption, and locking before sharing state;
no remote backend is configured here. State, plans, `.terraform/`, and private
tfvars are ignored; the dependency lock file is intentionally committed.

Terraform replaces Python's plan/apply, ownership registry and ID-based adoption
with plans, state and imports. It does **not** reproduce Python's separate
`--allow-deletes` flag, example-name apply prohibition, snapshot rechecks, collision
checks, or bounded post-write verification. Terraform's plan review and apply
confirmation are the mutation boundary; do not use unattended auto-approval.
It does not run Python's `--report` spend SQL; keep using that separate read-only
reporting path with explicitly chosen workspace/account profiles.

## Offline verification (no account access)

```sh
terraform -chdir=terraform/budgets fmt -check -recursive
terraform -chdir=terraform/budgets init -backend=false
terraform -chdir=terraform/budgets validate
terraform -chdir=terraform/budgets test -filter=tests/budgets.tftest.hcl
cp terraform/budgets/terraform.tfvars.example terraform/budgets/terraform.tfvars
terraform -chdir=terraform/budgets validate
terraform -chdir=terraform/budgets test -test-directory=example-tests
rm terraform/budgets/terraform.tfvars
```

Only copy/remove the example if no private tfvars file exists. `validate` checks
configuration, not variable values; the example mock plan exercises those too.
Tests use Terraform's mock provider, `command = plan` only, synthetic numeric
workspace fixtures, a reserved `.invalid` email, and no credentials or API calls.
No live plan, apply, import, or spend SQL was executed for verification.

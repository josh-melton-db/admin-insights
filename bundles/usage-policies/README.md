# usage-policies notebook

Serverless usage policies (projects and cost centers) as code, in one Databricks
notebook. A workspace admin who is not an account admin declares policies as
Python variables, sees a plan, applies it, and reports chargeback spend by
policy and tag. The workflow is like a bundle (declare, plan, apply), but there
is no CLI and no DAB resource.

- `src/manage_usage_policies.py`: the notebook (source format). It holds the
  declarations and widgets, calls the lib, and displays the output.
- `src/usage_policies_lib.py`: validation, planning, apply, import, and the
  chargeback query, plus a thin client over `w.api_client.do`.
- `SPEC.md`: the agreed spec and the live-verified API contract.

The notebook runs with your own workspace credentials (`WorkspaceClient()`). It
never uses the account host, `AccountClient`, or account-admin credentials. No
workspace host, workspace ID, account ID, or email is committed. They are
discovered at runtime.

## Import and run

Import the `src/` folder into your workspace. The notebook imports the lib from
its own folder, so keep the two files together:

```bash
databricks workspace import-dir bundles/usage-policies/src /Users/<you>/usage-policies --profile <profile>
```

Open `manage_usage_policies`, attach it to **serverless**, and run all. The
widgets are:

| Widget | Default | Meaning |
|--------|---------|---------|
| `apply` | `false` | `true` executes the plan. With `false` the notebook only validates, plans, imports, and reports chargeback. |
| `allow_deletes` | `false` | `true` allows planned deletes to execute (needs `apply=true` too). |
| `chargeback_start_date` / `chargeback_end_date` | last 30 days | `YYYY-MM-DD` range for the chargeback cells. |
| `account_id` | empty | Overrides the discovered account ID. |

The cells run in this order: declare, widgets, validate (fails fast and lists every error),
plan, apply (only with `apply=true`), import, and chargeback.

## Declare policies

Edit the first cell. `REQUIRED_TAG_KEYS` sets the tag keys every policy must
have. Each `POLICIES` entry is a dict:

```python
REQUIRED_TAG_KEYS = ["cost_center", "project", "owner"]
POLICIES = [
    {
        "name": "data-eng-ingest",
        "tags": {"cost_center": "CC-1234", "project": "ingest", "owner": "data-eng"},
        "workspace_ids": "all",                 # omit = this workspace; "all" = every workspace; or [id, ...]
        "users": ["groups/data-engineers"],     # get roles/budgetPolicy.user
        "managers": ["groups/platform-admins"], # get roles/budgetPolicy.manager
    },
]
```

Principals are `users/<email>`, `groups/<account group name>`, or
`servicePrincipals/<applicationId>`. Validation checks the following:

- Names are unique and 1-127 characters long.
- Tag values are at most 256 characters, and tag keys are unique (case-insensitive).
- There are at most 20 tags, including the marker below.
- Every required key is present.
- No tag uses a reserved key (`budget-policy-name`, `budget-policy-id`,
  `budget-policy-resolution-result`, or the marker key itself).
- Principals and workspace IDs are well formed.

The two shipped policies (`example-*`) are fake. Replace them before you set
`apply=true`.

### Adopt existing policies

The import cell prints every policy you can see as a ready-to-paste `POLICIES`
literal, with the marker tag stripped. If your caller cannot read a policy's
grants, the literal leaves out `users`/`managers` and says so in a comment. Paste the
policies you want to manage into cell 1. With `apply=true` they are then adopted:
the plan shows `adopt`, and apply adds the marker plus the declared fields.

## Plan actions

| Action | When |
|--------|------|
| `create` | No live policy has the declared name. |
| `adopt` | A live policy has the name but no marker. Apply adds the marker and the declared fields. |
| `update` | A managed policy differs. The plan shows each field change (`+`/`-`/`~` per tag, plus the workspaces). |
| `grants` | User or Manager principals differ. The plan lists the principals added and removed per role. |
| `delete` | A managed policy is no longer in `POLICIES`. |
| `no-op` | The live policy matches the declaration. |
| `error` | A policy could not be read (for example, a 403). It is reported, and the other policies continue. |

## Safety rules

- **Managed marker.** Every created or adopted policy gets
  `managed_by=usage-policies-notebook`. This tag counts toward the 20-tag limit.
- **Matching** is by exact `policy_name`.
- **Deletes** are planned only for policies that have the marker and are absent
  from `POLICIES`. They execute only when `apply=true` and `allow_deletes=true`. Policies
  without the marker are never modified or deleted unless you declare them. All
  policies that carry the marker and that you can see are in scope, including
  policies managed from another workspace's copy of this notebook. Declare them,
  or leave `allow_deletes=false`.
- **Grants** are authoritative for `roles/budgetPolicy.user` and
  `roles/budgetPolicy.manager` on declared policies. An empty list removes
  everyone from that role. The single exception is your own Manager grant: it is
  never removed, so you cannot lock yourself out, and the plan says so. Grant rules for
  other roles are left unchanged. Each write uses the etag from the latest read.
- **Updates** always send the full desired policy object (name, tags, workspaces).
  The API clears any field that is omitted, and tags are replaced as a whole.
- **Retries.** Each create carries a `request_id` derived from a per-session
  run token and the policy name. Re-running a failed apply cell replays the same
  create instead of creating a duplicate. The token rotates after a fully successful
  apply.
- **Errors** are per policy. A 403 on one policy does not stop the others. The
  apply table shows `ok`, `failed`, `skipped`, or `unconfirmed` for every step,
  and the cell raises at the end if anything failed.
- **Eventual consistency.** Reads after writes can be stale for a few seconds,
  and they can flip between fresh and stale. Apply therefore re-reads each change
  (GET, rule set, and the list that the next plan uses) with bounded backoff. It
  marks a step `ok` only after several consecutive fresh reads; otherwise the step is `unconfirmed`. If a
  plan right after an apply still shows the old state, wait a few seconds and
  re-run it. The repeat is harmless, because updates are idempotent and a duplicate create
  fails with 409 `ALREADY_EXISTS`.

## Permissions

- A **workspace admin** can create policies, and becomes their Manager.
- The list shows only the policies the caller can see. To see every policy in the
  account, the caller needs the account **Billing admin** role. Reading or changing
  the grants on a policy needs its Manager role.
- Groups in `users` and `managers` must be **account** groups. Workspace-local
  groups (for example `users`) are rejected with 400 "Group ... not found".
- Chargeback reads `system.billing.usage` and `system.billing.list_prices`. A
  workspace admin can query both. The usage covers the whole account, and the IDs of
  policies you cannot see are shown as "(not visible to caller)", because no
  system table lists policy names.

## Account ID discovery

The rule-set proxy needs the account ID. The notebook reads it from the
workspace host's `GET /.well-known/databricks-config` (the SDK's host-metadata
endpoint, which returns `account_id`). That call uses neither account credentials
nor the account host. Use the `account_id` widget to override the value.

## API caveat

Policies are managed through `/api/2.0/serverless-policies` on the workspace
host. This route is undocumented, but the Databricks CLI uses it. Grants go
through the `/api/2.0/preview/accounts/access-control/rule-sets` proxy. Both are
preview surfaces, so they may change. See `SPEC.md` for the verified contract.

## Tests

The unit tests mock `w.api_client.do`:

```bash
python3 -m pytest -q bundles/usage-policies/tests/
```

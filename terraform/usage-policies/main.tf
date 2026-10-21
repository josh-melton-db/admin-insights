provider "databricks" {
  host       = var.account_host
  account_id = var.account_id
  profile    = var.account_profile
}

locals {
  policies = { for key, policy in var.policies : key => {
    name          = policy.name
    tags          = tomap(policy.tags)
    workspace_ids = try(policy.workspace_ids, null)
    users         = toset(coalesce(try(policy.users, null), []))
    managers      = toset(coalesce(try(policy.managers, null), []))
  } }
}

resource "databricks_budget_policy" "this" {
  for_each = local.policies

  policy_name = each.value.name
  custom_tags = [for key, value in each.value.tags : { key = key, value = value }]
  binding_workspace_ids = each.value.workspace_ids == null ? [var.default_workspace_id] : (
    try(each.value.workspace_ids == "all", false) ? [] : tolist(each.value.workspace_ids)
  )
}

resource "databricks_access_control_rule_set" "this" {
  for_each = local.policies

  name = "accounts/${var.account_id}/budgetPolicies/${databricks_budget_policy.this[each.key].policy_id}/ruleSets/default"
  api  = "account"

  dynamic "grant_rules" {
    for_each = { for role, principals in {
      "roles/budgetPolicy.user"    = each.value.users
      "roles/budgetPolicy.manager" = each.value.managers
    } : role => principals if length(principals) > 0 }
    content {
      role       = grant_rules.key
      principals = grant_rules.value
    }
  }
}

provider "databricks" {
  host       = var.account_host
  account_id = var.account_id
  profile    = var.account_profile
}

resource "databricks_budget" "this" {
  for_each = var.budgets

  display_name  = each.value.name
  resource_type = "BUDGET_RESOURCE_TYPE_ALL_RESOURCES"

  alert_configurations {
    quantity_threshold = tostring(each.value.amount)
    time_period        = each.value.time_period
    quantity_type      = each.value.quantity_type
    trigger_type       = "CUMULATIVE_SPENDING_EXCEEDED"
    scope_type         = "ALERT_CONFIGURATION_SCOPE_TYPE_SHARED"

    dynamic "action_configurations" {
      for_each = each.value.notification_emails
      content {
        action_type = "EMAIL_NOTIFICATION"
        target      = action_configurations.value
      }
    }
  }

  dynamic "filter" {
    for_each = each.value.scope == "workspace" || each.value.workspace_ids != null || length(each.value.tags) > 0 ? [each.value] : []
    content {
      dynamic "workspace_id" {
        for_each = each.value.scope == "workspace" || each.value.workspace_ids != null ? [each.value] : []
        content {
          operator = "IN"
          values   = each.value.scope == "workspace" ? [each.value.workspace_id] : tolist(each.value.workspace_ids)
        }
      }
      dynamic "tags" {
        for_each = each.value.tags
        content {
          key = tags.key
          value {
            operator = "IN"
            values   = sort(tolist(tags.value))
          }
        }
      }
    }
  }
}

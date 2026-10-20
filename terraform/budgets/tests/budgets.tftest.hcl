mock_provider "databricks" {}

variables {
  account_id      = "offline-test-only"
  account_profile = "offline-test-only"
}

run "empty_default" {
  command = plan
  assert {
    condition     = length(databricks_budget.this) == 0
    error_message = "Default configuration must not manage budgets."
  }
}

run "scope_and_alert_mapping" {
  command = plan
  variables {
    budgets = {
      workspace = {
        name                = "example-workspace"
        amount              = 100
        workspace_id        = 1
        notification_emails = ["test@example.invalid"]
        tags                = { project = ["example-project"] }
      }
      account = {
        name   = "example-account"
        amount = 200
        scope  = "account"
      }
      selected_workspaces = {
        name          = "example-selected-workspaces"
        amount        = 300
        scope         = "account"
        workspace_ids = [1, 2]
      }
    }
  }
  assert {
    condition = (
      length(databricks_budget.this) == 3 &&
      keys(output.budget_ids) == ["account", "selected_workspaces", "workspace"] &&
      databricks_budget.this["workspace"].filter[0].workspace_id[0].values == tolist([1]) &&
      databricks_budget.this["workspace"].filter[0].workspace_id[0].operator == "IN" &&
      length(databricks_budget.this["account"].filter) == 0 &&
      databricks_budget.this["selected_workspaces"].filter[0].workspace_id[0].values == tolist([1, 2])
    )
    error_message = "Scope must never silently broaden from workspace to account."
  }
  assert {
    condition = (
      databricks_budget.this["workspace"].display_name == "example-workspace" &&
      databricks_budget.this["workspace"].alert_configurations[0].quantity_threshold == "100" &&
      databricks_budget.this["workspace"].alert_configurations[0].time_period == "MONTH" &&
      databricks_budget.this["workspace"].alert_configurations[0].quantity_type == "LIST_PRICE_DOLLARS_USD" &&
      databricks_budget.this["workspace"].alert_configurations[0].trigger_type == "CUMULATIVE_SPENDING_EXCEEDED" &&
      databricks_budget.this["workspace"].alert_configurations[0].action_configurations[0].action_type == "EMAIL_NOTIFICATION" &&
      databricks_budget.this["workspace"].alert_configurations[0].action_configurations[0].target == "test@example.invalid" &&
      databricks_budget.this["workspace"].filter[0].tags[0].key == "project" &&
      databricks_budget.this["workspace"].filter[0].tags[0].value[0].values == tolist(["example-project"]) &&
      databricks_budget.this["workspace"].filter[0].tags[0].value[0].operator == "IN"
    )
    error_message = "Declarations must map to the provider's alert and tag blocks."
  }
}

run "missing_workspace_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1 } }
  }
  expect_failures = [var.budgets]
}

run "invalid_amount_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 0, scope = "account" } }
  }
  expect_failures = [var.budgets]
}

run "empty_profile_rejected" {
  command = plan
  variables {
    account_profile = " "
  }
  expect_failures = [var.account_profile]
}

run "account_scope_conflict_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, scope = "account", workspace_id = 1 } }
  }
  expect_failures = [var.budgets]
}

run "workspace_scope_conflict_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = 1, workspace_ids = [1, 2] } }
  }
  expect_failures = [var.budgets]
}

run "empty_workspace_list_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, scope = "account", workspace_ids = [] } }
  }
  expect_failures = [var.budgets]
}

run "fractional_workspace_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = 1.5 } }
  }
  expect_failures = [var.budgets]
}

run "empty_tag_values_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, scope = "account", tags = { project = [] } } }
  }
  expect_failures = [var.budgets]
}

run "invalid_recipient_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, scope = "account", notification_emails = ["not-an-email"] } }
  }
  expect_failures = [var.budgets]
}

run "unsupported_period_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, scope = "account", time_period = "DAY" } }
  }
  expect_failures = [var.budgets]
}

run "duplicate_names_rejected" {
  command = plan
  variables {
    budgets = {
      first  = { name = "example-duplicate", amount = 1, scope = "account" }
      second = { name = "example-duplicate", amount = 2, scope = "account" }
    }
  }
  expect_failures = [var.budgets]
}

run "workspace_host_rejected" {
  command = plan
  variables {
    account_host = "https://workspace.example.invalid"
  }
  expect_failures = [var.account_host]
}

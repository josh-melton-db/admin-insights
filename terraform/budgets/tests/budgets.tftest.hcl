mock_provider "databricks" {}

run "malformed_account_id_rejected" {
  command = plan
  variables {
    account_id = "not-a-uuid"
  }
  expect_failures = [var.account_id]
}

run "null_workspace_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = null } }
  }
  expect_failures = [var.budgets]
}

run "negative_workspace_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = -1 } }
  }
  expect_failures = [var.budgets]
}

variables {
  account_id      = "00000000-0000-0000-0000-000000000001"
  account_profile = "offline-test-only"
  budgets         = {}
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
      untagged = {
        name         = "example-untagged"
        amount       = 200
        workspace_id = 2
      }
    }
  }
  assert {
    condition = (
      length(databricks_budget.this) == 2 &&
      keys(output.budget_ids) == ["untagged", "workspace"] &&
      length(databricks_budget.this["workspace"].filter[0].workspace_id) == 1 &&
      databricks_budget.this["workspace"].filter[0].workspace_id[0].values == tolist([1]) &&
      databricks_budget.this["workspace"].filter[0].workspace_id[0].operator == "IN" &&
      databricks_budget.this["untagged"].filter[0].workspace_id[0].operator == "IN" &&
      databricks_budget.this["untagged"].filter[0].workspace_id[0].values == tolist([2])
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

run "legacy_attributes_cannot_broaden_scope" {
  command = plan
  variables {
    budgets = {
      legacy = {
        name          = "example-legacy"
        amount        = 1
        workspace_id  = 1
        scope         = "account"
        workspace_ids = [1, 2]
      }
    }
  }
  assert {
    condition = (
      length(databricks_budget.this["legacy"].filter[0].workspace_id) == 1 &&
      databricks_budget.this["legacy"].filter[0].workspace_id[0].operator == "IN" &&
      databricks_budget.this["legacy"].filter[0].workspace_id[0].values == tolist([1])
    )
    error_message = "Unknown object attributes are discarded by Terraform and must never broaden scope."
  }
}

run "legacy_account_without_workspace_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, scope = "account", workspace_ids = [1, 2] } }
  }
  expect_failures = [var.budgets]
}

run "empty_name_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "", amount = 1, workspace_id = 1 } }
  }
  expect_failures = [var.budgets]
}

run "maximum_name_length_accepted" {
  command = plan
  variables {
    budgets = { boundary = { name = join("", [for index in range(128) : "x"]), amount = 1, workspace_id = 1 } }
  }
  assert {
    condition     = length(databricks_budget.this["boundary"].display_name) == 128
    error_message = "Names of exactly 128 characters must remain supported."
  }
}

run "oversized_workspace_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = 9223372036854775808 } }
  }
  expect_failures = [var.budgets]
}

run "invalid_amount_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 0, workspace_id = 1 } }
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

run "blank_name_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = " ", amount = 1, workspace_id = 1 } }
  }
  expect_failures = [var.budgets]
}

run "long_name_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = join("", [for index in range(129) : "x"]), amount = 1, workspace_id = 1 } }
  }
  expect_failures = [var.budgets]
}

run "zero_workspace_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = 0 } }
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
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = 1, tags = { project = [] } } }
  }
  expect_failures = [var.budgets]
}

run "invalid_recipient_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = 1, notification_emails = ["not-an-email"] } }
  }
  expect_failures = [var.budgets]
}

run "unsupported_period_rejected" {
  command = plan
  variables {
    budgets = { invalid = { name = "example-invalid", amount = 1, workspace_id = 1, time_period = "DAY" } }
  }
  expect_failures = [var.budgets]
}

run "duplicate_names_rejected" {
  command = plan
  variables {
    budgets = {
      first  = { name = "example-duplicate", amount = 1, workspace_id = 1 }
      second = { name = "example-duplicate", amount = 2, workspace_id = 1 }
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

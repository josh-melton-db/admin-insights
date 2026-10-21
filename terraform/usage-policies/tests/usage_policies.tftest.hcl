mock_provider "databricks" {
  mock_resource "databricks_budget_policy" {
    defaults = { policy_id = "example-policy-id" }
  }
}

variables {
  account_id           = "00000000-0000-0000-0000-000000000001"
  account_profile      = "example-offline-only"
  default_workspace_id = 1
}

run "empty_default" {
  command = plan
  assert {
    condition     = length(databricks_budget_policy.this) == 0 && length(databricks_access_control_rule_set.this) == 0
    error_message = "Empty input must manage no policies or grants."
  }
}

run "example_mapping" {
  command = plan
  variables {
    policies = {
      example_data_eng_project = {
        name = "example-data-eng-project"
        tags = { cost_center = "CC-0000-EXAMPLE", project = "example-ingest", owner = "example-team" }
      }
      example_ml_research = {
        name = "example-ml-research"
        tags = { cost_center = "CC-9999-EXAMPLE", project = "example-forecasting", owner = "example-ml-team" }
      }
    }
  }
  assert {
    condition = (
      toset(keys(output.policy_ids)) == toset(["example_data_eng_project", "example_ml_research"]) &&
      databricks_budget_policy.this["example_data_eng_project"].policy_name == "example-data-eng-project" &&
      databricks_budget_policy.this["example_data_eng_project"].binding_workspace_ids == tolist([1]) &&
      tomap({ for tag in databricks_budget_policy.this["example_data_eng_project"].custom_tags : tag.key => tag.value }) == tomap({ cost_center = "CC-0000-EXAMPLE", project = "example-ingest", owner = "example-team" })
    )
    error_message = "The notebook example must retain names, tags and workspace scope."
  }
}

run "bindings_and_grants" {
  command = apply
  variables {
    required_tag_keys    = []
    default_workspace_id = null
    policies = {
      all   = { name = "example-all", tags = {}, workspace_ids = "all" }
      empty = { name = "example-empty", tags = {}, workspace_ids = [] }
      explicit = {
        name          = "example-explicit"
        tags          = { project = "example-project" }
        workspace_ids = [2, 3]
        users         = ["users/example-user", "servicePrincipals/example-app"]
        managers      = ["groups/example-managers"]
      }
    }
  }
  assert {
    condition = (
      length(databricks_budget_policy.this["all"].binding_workspace_ids) == 0 &&
      length(databricks_budget_policy.this["empty"].binding_workspace_ids) == 0 &&
      databricks_budget_policy.this["explicit"].binding_workspace_ids == tolist([2, 3])
    )
    error_message = "All and empty must be account-wide; explicit bindings must remain scoped."
  }
  assert {
    condition = (
      databricks_access_control_rule_set.this["explicit"].name == "accounts/00000000-0000-0000-0000-000000000001/budgetPolicies/example-policy-id/ruleSets/default" &&
      tomap({ for grant in databricks_access_control_rule_set.this["explicit"].grant_rules : grant.role => grant.principals }) == tomap({
        "roles/budgetPolicy.user"    = toset(["servicePrincipals/example-app", "users/example-user"])
        "roles/budgetPolicy.manager" = toset(["groups/example-managers"])
      }) && length(databricks_access_control_rule_set.this["all"].grant_rules) == 0
    )
    error_message = "Rule sets must use policy IDs and the authoritative User/Manager roles."
  }
}

run "limits_are_inclusive" {
  command = plan
  variables {
    required_tag_keys = []
    policies = {
      boundary = {
        name  = join("", [for index in range(127) : "x"])
        tags  = { for index in range(20) : "example-${index}" => join("", [for character in range(256) : "x"]) }
        users = ["groups/example team"]
      }
    }
  }
  assert {
    condition     = length(databricks_budget_policy.this["boundary"].policy_name) == 127 && length(databricks_budget_policy.this["boundary"].custom_tags) == 20
    error_message = "The maximum valid name/tag lengths and groups with spaces must be accepted."
  }
}

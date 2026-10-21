mock_provider "databricks" {}

run "checked_in_example" {
  command = plan
  assert {
    condition = (
      length(databricks_budget_policy.this) == 2 &&
      databricks_budget_policy.this["example_data_eng_project"].binding_workspace_ids == tolist([1]) &&
      databricks_budget_policy.this["example_ml_research"].binding_workspace_ids == tolist([1, 2]) &&
      length(databricks_access_control_rule_set.this["example_ml_research"].grant_rules) == 2
    )
    error_message = "The checked-in example must preserve workspace bindings and grants."
  }
}

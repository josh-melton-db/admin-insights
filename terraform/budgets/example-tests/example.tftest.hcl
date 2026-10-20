mock_provider "databricks" {}

run "example_shape" {
  command = plan
  assert {
    condition = (
      length(databricks_budget.this) == 1 &&
      databricks_budget.this["example_team_monthly"].display_name == "example-team-monthly" &&
      length(databricks_budget.this["example_team_monthly"].filter[0].workspace_id) == 0 &&
      databricks_budget.this["example_team_monthly"].filter[0].tags[0].key == "project" &&
      databricks_budget.this["example_team_monthly"].alert_configurations[0].quantity_threshold == "100" &&
      length(databricks_budget.this["example_team_monthly"].alert_configurations[0].action_configurations) == 0
    )
    error_message = "Example must produce one account-scoped tag-filtered budget with no email actions."
  }
}

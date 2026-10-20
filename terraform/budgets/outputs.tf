output "budget_ids" {
  description = "Budget configuration IDs by stable declaration key (import uses account_id|budget_id)."
  value       = { for key, budget in databricks_budget.this : key => budget.budget_configuration_id }
}

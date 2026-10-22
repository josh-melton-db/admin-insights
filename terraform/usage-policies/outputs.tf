output "policy_ids" {
  description = "Budget policy IDs by stable declaration key."
  value       = { for key, policy in databricks_budget_policy.this : key => policy.policy_id }
}

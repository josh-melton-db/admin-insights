variable "account_host" {
  description = "Accounts host for your cloud (not a workspace URL)."
  type        = string
  default     = "https://accounts.cloud.databricks.com"
  nullable    = false
  validation {
    condition = contains([
      "https://accounts.cloud.databricks.com",
      "https://accounts.azuredatabricks.net",
      "https://accounts.gcp.databricks.com",
    ], var.account_host)
    error_message = "Use the HTTPS Databricks accounts host for your cloud."
  }
}

variable "account_id" {
  description = "Explicit account ID; must match the selected account profile."
  type        = string
  nullable    = false
  validation {
    condition     = length(trimspace(var.account_id)) > 0
    error_message = "An explicit account ID is required."
  }
}

variable "account_profile" {
  description = "Explicit Databricks CLI account profile; never inferred or defaulted."
  type        = string
  nullable    = false
  validation {
    condition     = length(trimspace(var.account_profile)) > 0
    error_message = "Choose a nonblank account profile explicitly."
  }
}

variable "budgets" {
  description = "Budgets keyed by stable Terraform identity. Workspace scope requires workspace_id; account scope explicitly permits all spend or workspace_ids."
  type = map(object({
    name                = string
    amount              = number
    time_period         = optional(string, "MONTH")
    quantity_type       = optional(string, "LIST_PRICE_DOLLARS_USD")
    notification_emails = optional(set(string), [])
    tags                = optional(map(set(string)), {})
    scope               = optional(string, "workspace")
    workspace_id        = optional(number)
    workspace_ids       = optional(set(number))
  }))
  default  = {}
  nullable = false

  validation {
    condition = alltrue([for key, budget in var.budgets : try(
      length(trimspace(key)) > 0 && length(trimspace(budget.name)) > 0 &&
      length(budget.name) <= 128 && budget.amount > 0 &&
      budget.time_period == "MONTH" && budget.quantity_type == "LIST_PRICE_DOLLARS_USD", false)
    ])
    error_message = "Use nonblank keys/names (names <=128 characters), positive amounts, MONTH, and LIST_PRICE_DOLLARS_USD."
  }
  validation {
    condition     = length(distinct([for budget in var.budgets : budget.name])) == length(var.budgets)
    error_message = "Budget display names must be unique."
  }
  validation {
    condition = alltrue([for budget in var.budgets : try(
      budget.scope == "workspace" ? (
        budget.workspace_id != null && budget.workspace_ids == null
        ) : (
        budget.scope == "account" && budget.workspace_id == null
      ), false)
    ])
    error_message = "Workspace scope requires workspace_id and forbids workspace_ids; explicit account scope forbids workspace_id and optionally accepts workspace_ids."
  }
  validation {
    condition = alltrue([for budget in var.budgets : alltrue([
      for workspace_id in(budget.workspace_id != null ? [budget.workspace_id] : (budget.workspace_ids != null ? tolist(budget.workspace_ids) : [])) :
      try(workspace_id > 0 && workspace_id <= 9223372036854775807 && floor(workspace_id) == workspace_id, false)
    ]) && (budget.workspace_ids == null ? true : length(budget.workspace_ids) > 0)])
    error_message = "Workspace IDs must be positive int64 integers; workspace_ids cannot be empty."
  }
  validation {
    condition = alltrue([for budget in var.budgets : alltrue([
      for email in budget.notification_emails : can(regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", email))
      ]) && alltrue([
      for key, values in budget.tags : length(trimspace(key)) > 0 && length(values) > 0 && alltrue([for value in values : value != null])
    ])])
    error_message = "Recipients must be email addresses; tags need nonblank keys and nonempty sets of string values."
  }
}

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
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.account_id))
    error_message = "An explicit account ID in UUID format is required."
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
  description = "Workspace-specific budgets keyed by stable Terraform identity. Every budget requires one positive integer workspace_id."
  type = map(object({
    name                = string
    amount              = number
    time_period         = optional(string, "MONTH")
    quantity_type       = optional(string, "LIST_PRICE_DOLLARS_USD")
    notification_emails = optional(set(string), [])
    tags                = optional(map(set(string)), {})
    workspace_id        = optional(number)
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
      budget.workspace_id > 0 && budget.workspace_id <= 9223372036854775807 && floor(budget.workspace_id) == budget.workspace_id, false)
    ])
    error_message = "Every budget requires workspace_id: a positive int64 integer."
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

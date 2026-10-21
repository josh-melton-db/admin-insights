variable "account_host" {
  description = "Accounts host for your cloud, not a workspace URL."
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
  description = "Explicit account ID matching the chosen account profile."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.account_id))
    error_message = "An explicit account ID in UUID format is required."
  }
}

variable "account_profile" {
  description = "Explicit Databricks CLI account login profile; never inferred or defaulted."
  type        = string
  nullable    = false
  validation {
    condition     = length(trimspace(var.account_profile)) > 0
    error_message = "Choose a nonblank account profile explicitly."
  }
}

variable "default_workspace_id" {
  description = "Explicit fallback for omitted workspace_ids. Account providers cannot discover a current workspace; null requires each policy to specify its bindings."
  type        = number
  default     = null
  validation {
    condition     = var.default_workspace_id == null ? true : try(var.default_workspace_id > 0 && floor(var.default_workspace_id) == var.default_workspace_id && var.default_workspace_id <= 9223372036854775807, false)
    error_message = "default_workspace_id must be null or a positive int64 integer."
  }
}

variable "required_tag_keys" {
  description = "Tag keys requiring nonempty values on every policy."
  type        = set(string)
  default     = ["cost_center", "project", "owner"]
  nullable    = false
  validation {
    condition     = alltrue([for key in var.required_tag_keys : try(length(trimspace(key)) > 0, false)])
    error_message = "Required tag keys must be nonblank."
  }
}

variable "policies" {
  description = "Policies keyed by stable Terraform identity. workspace_ids is omitted (explicit default workspace), all, or a list of workspace IDs (empty means all)."
  type        = any
  default     = {}
  nullable    = false

  validation {
    condition = can(keys(var.policies)) && try(alltrue([for policy in var.policies :
      can(keys(policy)) && can(keys(policy.tags)) && can(tostring(policy.name)) &&
      alltrue([for field in keys(policy) : contains(["name", "tags", "workspace_ids", "users", "managers"], field)]) &&
      alltrue([for value in values(policy.tags) : value != null && can(tostring(value))]) &&
      can(toset(coalesce(try(policy.users, null), []))) && can(toset(coalesce(try(policy.managers, null), [])))
    ]), false)
    error_message = "policies must be a map of objects with name, tags (string map), and optional workspace_ids, users and managers. Unknown fields are rejected."
  }

  validation {
    condition = alltrue([for key, policy in var.policies : try(
      length(trimspace(key)) > 0 && length(trimspace(policy.name)) > 0 && length(policy.name) <= 127, false)
    ])
    error_message = "Policy keys and names must be nonblank; names must be 1-127 characters."
  }
  validation {
    condition     = length(distinct([for policy in var.policies : policy.name])) == length(var.policies)
    error_message = "Policy names must be unique."
  }
  validation {
    condition = alltrue([for policy in var.policies : try(
      length(policy.tags) <= 20 &&
      length(distinct([for key in keys(policy.tags) : lower(key)])) == length(policy.tags) &&
      alltrue([for key, value in policy.tags : length(trimspace(key)) > 0 && length(value) <= 256 && !contains([
        "budget-policy-name", "budget-policy-id", "budget-policy-resolution-result"
      ], lower(key))]), false)
    ])
    error_message = "Use at most 20 tags, nonblank case-insensitively unique nonreserved keys, and nonnull values of at most 256 characters."
  }
  validation {
    condition = alltrue([for policy in var.policies : alltrue([
      for key in var.required_tag_keys : try(length(policy.tags[key]) > 0, false)
    ])])
    error_message = "Every policy must include nonempty values for all required_tag_keys."
  }
  validation {
    condition = alltrue([for policy in var.policies : alltrue([
      for principal in setunion(coalesce(try(policy.users, null), []), coalesce(try(policy.managers, null), [])) : can(regex("^(users|groups|servicePrincipals)/[^/]+$", principal))
    ])])
    error_message = "Principals must match users/<name>, groups/<name>, or servicePrincipals/<applicationId>."
  }
  validation {
    condition = alltrue([for policy in var.policies : try(policy.workspace_ids, null) == null ? var.default_workspace_id != null : (
      try(policy.workspace_ids == "all", false) || try(alltrue([
        for workspace_id in tolist(policy.workspace_ids) : workspace_id > 0 && workspace_id <= 9223372036854775807 && floor(workspace_id) == workspace_id
      ]), false)
    )])
    error_message = "workspace_ids must be all, an empty list, or positive int64 IDs; omission requires default_workspace_id (never silently broaden scope)."
  }
}

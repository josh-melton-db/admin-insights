mock_provider "databricks" {}

variables {
  account_id           = "00000000-0000-0000-0000-000000000001"
  account_profile      = "example-offline-only"
  default_workspace_id = 1
  required_tag_keys    = []
}

run "reserved_key_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = { budget-policy-id = "example-id" } } }
  }
  expect_failures = [var.policies]
}

run "missing_required_tag_rejected" {
  command = plan
  variables {
    required_tag_keys = ["owner"]
    policies          = { invalid = { name = "example-invalid", tags = {} } }
  }
  expect_failures = [var.policies]
}

run "too_many_tags_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = { for index in range(21) : "example-${index}" => "example" } } }
  }
  expect_failures = [var.policies]
}

run "bad_user_principal_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = {}, users = ["example-user"] } }
  }
  expect_failures = [var.policies]
}

run "bad_manager_principal_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = {}, managers = ["groups/"] } }
  }
  expect_failures = [var.policies]
}

run "duplicate_names_rejected" {
  command = plan
  variables {
    policies = {
      first  = { name = "example-duplicate", tags = {} }
      second = { name = "example-duplicate", tags = {} }
    }
  }
  expect_failures = [var.policies]
}

run "blank_name_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = " ", tags = {} } }
  }
  expect_failures = [var.policies]
}

run "long_name_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = join("", [for index in range(128) : "x"]), tags = {} } }
  }
  expect_failures = [var.policies]
}

run "long_tag_value_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = { example = join("", [for index in range(257) : "x"]) } } }
  }
  expect_failures = [var.policies]
}

run "case_duplicate_tags_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = { Project = "example", project = "example" } } }
  }
  expect_failures = [var.policies]
}

run "omitted_workspace_without_fallback_rejected" {
  command = plan
  variables {
    default_workspace_id = null
    policies             = { invalid = { name = "example-invalid", tags = {} } }
  }
  expect_failures = [var.policies]
}

run "negative_workspace_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = {}, workspace_ids = [-1] } }
  }
  expect_failures = [var.policies]
}

run "fractional_workspace_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = {}, workspace_ids = [1.5] } }
  }
  expect_failures = [var.policies]
}

run "bad_account_id_rejected" {
  command = plan
  variables {
    account_id = "example-not-a-uuid"
  }
  expect_failures = [var.account_id]
}

run "blank_profile_rejected" {
  command = plan
  variables {
    account_profile = " "
  }
  expect_failures = [var.account_profile]
}

run "unknown_field_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = {}, workspace_id = 2 } }
  }
  expect_failures = [var.policies]
}

run "empty_required_value_rejected" {
  command = plan
  variables {
    required_tag_keys = ["owner"]
    policies          = { invalid = { name = "example-invalid", tags = { owner = "" } } }
  }
  expect_failures = [var.policies]
}

run "blank_tag_key_rejected" {
  command = plan
  variables {
    policies = { invalid = { name = "example-invalid", tags = { "" = "example" } } }
  }
  expect_failures = [var.policies]
}

locals {
  name_seed    = "${var.subscription_id}-${var.resource_group_name}-${var.location}"
  name_suffix  = substr(md5(local.name_seed), 0, 8)
  account_name = lower("aif-rta-${local.name_suffix}")

  role_ids = {
    cognitive_services_openai_user = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
    foundry_user                   = "53ca6127-db72-4b80-b1b0-d745d6d5456d"
    foundry_project_manager        = "eadc314b-1a2d-4efa-be10-5d325db5065e"
  }

}

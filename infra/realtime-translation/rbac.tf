# All grants are confined to the account or project created by this root.
# The UUIDv5 resource names are deterministic across retry and state recovery;
# no subscription- or resource-group-scoped role assignment is permitted.
resource "azapi_resource" "participant_openai_user" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "${azapi_resource.ai_services.id}|${var.participant_object_id}|${local.role_ids.cognitive_services_openai_user}")
  parent_id = azapi_resource.ai_services.id

  body = {
    properties = {
      principalId      = var.participant_object_id
      principalType    = "User"
      roleDefinitionId = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${local.role_ids.cognitive_services_openai_user}"
    }
  }
}

resource "azapi_resource" "participant_foundry_user" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "${azapi_resource.project.id}|${var.participant_object_id}|${local.role_ids.foundry_user}")
  parent_id = azapi_resource.project.id

  body = {
    properties = {
      principalId      = var.participant_object_id
      principalType    = "User"
      roleDefinitionId = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${local.role_ids.foundry_user}"
    }
  }
}

resource "azapi_resource" "participant_foundry_project_manager" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "${azapi_resource.project.id}|${var.participant_object_id}|${local.role_ids.foundry_project_manager}")
  parent_id = azapi_resource.project.id

  body = {
    properties = {
      principalId      = var.participant_object_id
      principalType    = "User"
      roleDefinitionId = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${local.role_ids.foundry_project_manager}"
    }
  }
}

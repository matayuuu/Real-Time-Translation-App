resource "azapi_resource" "ai_services" {
  type      = "Microsoft.CognitiveServices/accounts@2026-05-01"
  name      = local.account_name
  parent_id = data.azapi_resource.target_resource_group.id
  location  = var.location
  tags      = var.tags

  identity {
    type = "SystemAssigned"
  }

  body = {
    kind = "AIServices"
    sku = {
      name = "S0"
    }
    properties = {
      allowProjectManagement = true
      customSubDomainName    = local.account_name
      disableLocalAuth       = true
      publicNetworkAccess    = "Enabled"
      networkAcls = {
        defaultAction = "Allow"
      }
    }
  }

  response_export_values = ["identity.principalId", "properties.endpoint"]
}

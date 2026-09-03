# This project deliberately uses Basic Agent Setup. No capability host, storage,
# Cosmos DB, or private networking resource is part of this companion app.
resource "azapi_resource" "project" {
  type      = "Microsoft.CognitiveServices/accounts/projects@2026-05-01"
  name      = var.project_name
  parent_id = azapi_resource.ai_services.id
  location  = var.location
  tags      = var.tags

  identity {
    type = "SystemAssigned"
  }

  body = {
    properties = {
      displayName = "Teams realtime translation"
      description = "Basic Microsoft Foundry project for the Windows Teams realtime translation companion app."
    }
  }
}

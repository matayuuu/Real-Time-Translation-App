# Cognitive Services can reject concurrent deployment PUTs immediately after an
# account is created, so model deployments are intentionally serialized.
resource "azapi_resource" "translation_deployment" {
  type      = "Microsoft.CognitiveServices/accounts/deployments@2026-05-01"
  name      = var.translation_model.deployment_name
  parent_id = azapi_resource.ai_services.id

  depends_on = [azapi_resource.project]

  body = {
    sku = {
      name     = var.translation_model.sku
      capacity = var.translation_model.capacity
    }
    properties = {
      model = {
        format  = "OpenAI"
        name    = var.translation_model.name
        version = var.translation_model.version
      }
    }
  }
}

resource "azapi_resource" "transcription_deployment" {
  type      = "Microsoft.CognitiveServices/accounts/deployments@2026-05-01"
  name      = var.transcription_model.deployment_name
  parent_id = azapi_resource.ai_services.id

  depends_on = [azapi_resource.translation_deployment]

  body = {
    sku = {
      name     = var.transcription_model.sku
      capacity = var.transcription_model.capacity
    }
    properties = {
      model = {
        format  = "OpenAI"
        name    = var.transcription_model.name
        version = var.transcription_model.version
      }
    }
  }
}

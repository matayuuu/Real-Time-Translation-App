output "resource_group_name" {
  value       = data.azapi_resource.target_resource_group.name
  description = "Existing resource group; this root never owns the resource group."
}

output "location" {
  value = var.location
}

output "account_name" {
  value = azapi_resource.ai_services.name
}

output "account_endpoint" {
  value = azapi_resource.ai_services.output.properties.endpoint
}

output "openai_endpoint" {
  value       = "https://${azapi_resource.ai_services.name}.openai.azure.com"
  description = "Keyless Azure OpenAI resource root for Microsoft Entra ID/RBAC clients."
}

output "project_name" {
  value = azapi_resource.project.name
}

output "project_endpoint" {
  value       = "https://${azapi_resource.ai_services.name}.services.ai.azure.com/api/projects/${azapi_resource.project.name}"
  description = "Microsoft Foundry project endpoint."
}

output "translation_deployment_name" {
  value = azapi_resource.translation_deployment.name
}

output "transcription_deployment_name" {
  value = azapi_resource.transcription_deployment.name
}

output "model_retirement_date" {
  value       = var.model_retirement_date
  description = "Review model availability before this date; deployments are not automatically migrated."
}

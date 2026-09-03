# This root reads the supplied resource group; it never owns the resource
# group and therefore cannot create or destroy it.
data "azapi_resource" "target_resource_group" {
  type      = "Microsoft.Resources/resourceGroups@2024-03-01"
  name      = var.resource_group_name
  parent_id = "/subscriptions/${var.subscription_id}"
}

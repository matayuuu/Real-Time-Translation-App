# This isolated root intentionally uses AzAPI only. AzureRM v5 invokes
# `az account list` during authentication, which cannot parse this tenant's
# malformed Azure CLI profile display name. AzAPI uses the active keyless
# Azure CLI token without requiring that profile enumeration.
provider "azapi" {
  subscription_id            = var.subscription_id
  skip_provider_registration = true
}

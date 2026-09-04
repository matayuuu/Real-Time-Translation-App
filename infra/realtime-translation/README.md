# Realtime translation infrastructure

This is an isolated Terraform root for the Windows Teams realtime translation
companion app. It reads an existing resource group and creates only an
AIServices account, a Basic Foundry project, three serialized deployments, and
resource-scoped access assignments. The deployments provide realtime
translation, realtime transcription, and post-conversation insights. Local
Terraform state is sensitive and is intentionally ignored by Git.

This root deliberately uses **AzAPI only**. AzureRM v5 authenticates by running
`az account list`, which can fail for Windows Azure CLI profiles whose tenant
display name contains a malformed non-ASCII escape. AzAPI uses the active
keyless Azure CLI token without that enumeration.

Use the PowerShell lifecycle scripts from the repository root:

```powershell
./scripts/realtime-translation-preflight.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME>
./scripts/setup-realtime-translation.ps1 `
  -SubscriptionId <SUBSCRIPTION_ID> `
  -ResourceGroupName <RESOURCE_GROUP_NAME>
```

The preflight is read-only. Setup and destroy require explicit typed
confirmation unless `-AutoApprove` is supplied. Neither operation creates or
deletes the resource group.

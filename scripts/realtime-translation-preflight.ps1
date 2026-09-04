[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName,

    [ValidateSet("eastus2")]
    [string]$Location = "eastus2",

    [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) ".realtime-translation\realtime-translation-preflight.json")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptName = Split-Path -Leaf $PSCommandPath
$requestedModels = @(
    [pscustomobject]@{
        deployment_name = "gpt-realtime-translate"
        name            = "gpt-realtime-translate"
        version         = "2026-05-06"
        sku             = "GlobalStandard"
        capacity        = 5
    },
    [pscustomobject]@{
        deployment_name = "gpt-realtime-whisper"
        name            = "gpt-realtime-whisper"
        version         = "2026-05-06"
        sku             = "GlobalStandard"
        capacity        = 5
    },
    [pscustomobject]@{
        deployment_name = "gpt-5.6-luna"
        name            = "gpt-5.6-luna"
        version         = "2026-07-09"
        sku             = "GlobalStandard"
        capacity        = 30
    }
)

function Assert-CommandAvailable {
    param([Parameter(Mandatory)][string]$Name)

    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$ScriptName requires '$Name' on PATH."
    }
}

function Get-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $json = & az @Arguments --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed: az $($Arguments -join ' ')"
    }
    if ([string]::IsNullOrWhiteSpace(($json -join "`n"))) {
        throw "Azure CLI command returned no JSON: az $($Arguments -join ' ')"
    }
    $payload = $json -join "`n"
    return ($payload | ConvertFrom-Json)
}

function Write-JsonAtomically {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string]$Path
    )

    $parent = Split-Path -Parent $Path
    if ([string]::IsNullOrWhiteSpace($parent)) {
        $parent = (Get-Location).Path
        $Path = Join-Path $parent $Path
    }
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $Value | ConvertTo-Json -Depth 12 | Set-Content -Path $temporaryPath -Encoding utf8NoBOM
    Move-Item -Force -Path $temporaryPath -Destination $Path
}

foreach ($tool in @("az", "terraform")) {
    Assert-CommandAvailable -Name $tool
}

$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet("pass", "fail")][string]$Status,
        [Parameter(Mandatory)][string]$Detail
    )
    [void]$checks.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail })
}

$account = Get-AzJson -Arguments @("account", "show")
if ([string]$account.id -ne $SubscriptionId) {
    Add-Check -Name "active-subscription" -Status "fail" -Detail (
        "Active subscription is '$($account.id)', not requested '$SubscriptionId'. " +
        "Run 'az account set --subscription $SubscriptionId' before setup."
    )
}
else {
    Add-Check -Name "active-subscription" -Status "pass" -Detail "Azure CLI is scoped to the requested subscription."
}

$resourceGroup = Get-AzJson -Arguments @(
    "group", "show", "--name", $ResourceGroupName, "--subscription", $SubscriptionId
)
Add-Check -Name "existing-resource-group" -Status "pass" -Detail (
    "Existing resource group '$ResourceGroupName' is visible (metadata location: '$($resourceGroup.location)')."
)

$provider = Get-AzJson -Arguments @(
    "provider", "show", "--namespace", "Microsoft.CognitiveServices", "--subscription", $SubscriptionId
)
if ([string]$provider.registrationState -eq "Registered") {
    Add-Check -Name "provider-registration" -Status "pass" -Detail "Microsoft.CognitiveServices is Registered."
}
else {
    Add-Check -Name "provider-registration" -Status "fail" -Detail (
        "Microsoft.CognitiveServices registration state is '$($provider.registrationState)'. " +
        "Ask a subscription administrator to register it; this script will not register providers."
    )
}

$callerIdLines = & az ad signed-in-user show --query id --output tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($callerIdLines -join "`n"))) {
    throw "Could not resolve the signed-in Entra user object ID. Use an interactive 'az login' identity with resource-group Owner access."
}
$callerObjectId = ($callerIdLines -join "`n").Trim()
$assignments = Get-AzJson -Arguments @(
    "role", "assignment", "list", "--assignee", $callerObjectId, "--scope", $resourceGroup.id,
    "--include-inherited", "--subscription", $SubscriptionId
)
$roleNames = @($assignments | ForEach-Object { [string]$_.roleDefinitionName })
$canProvision = $roleNames -contains "Owner" -or $roleNames -contains "Contributor"
$canAssignRoles = $roleNames -contains "Owner" -or $roleNames -contains "User Access Administrator"
if ($canProvision -and $canAssignRoles) {
    Add-Check -Name "caller-permissions" -Status "pass" -Detail (
        "Caller '$callerObjectId' can provision resources and create required resource-scoped role assignments."
    )
}
else {
    Add-Check -Name "caller-permissions" -Status "fail" -Detail (
        "Caller '$callerObjectId' needs resource provisioning access plus Owner or User Access Administrator on '$ResourceGroupName'."
    )
}

$catalog = Get-AzJson -Arguments @(
    "cognitiveservices", "model", "list", "--location", $Location, "--subscription", $SubscriptionId
)
$catalogItems = if ($null -ne $catalog.PSObject.Properties["value"]) { @($catalog.value) } else { @($catalog) }
$usage = Get-AzJson -Arguments @(
    "cognitiveservices", "usage", "list", "--location", $Location, "--subscription", $SubscriptionId
)
$usageItems = if ($null -ne $usage.PSObject.Properties["value"]) { @($usage.value) } else { @($usage) }

$nameSeed = "$SubscriptionId-$ResourceGroupName-$Location"
$nameHash = [Convert]::ToHexString(
    [Security.Cryptography.MD5]::HashData([Text.Encoding]::UTF8.GetBytes($nameSeed))
).ToLowerInvariant()
$accountName = "aif-rta-$($nameHash.Substring(0, 8))"
$accounts = Get-AzJson -Arguments @(
    "cognitiveservices", "account", "list", "--resource-group", $ResourceGroupName,
    "--subscription", $SubscriptionId
)
$existingAccount = @($accounts | Where-Object { [string]$_.name -eq $accountName }) | Select-Object -First 1
$existingDeployments = @()
if ($null -ne $existingAccount) {
    $deploymentResponse = Get-AzJson -Arguments @(
        "cognitiveservices", "account", "deployment", "list",
        "--name", $accountName,
        "--resource-group", $ResourceGroupName,
        "--subscription", $SubscriptionId
    )
    $existingDeployments = if ($null -eq $deploymentResponse) {
        @()
    }
    elseif ($null -ne $deploymentResponse.PSObject.Properties["value"]) {
        @($deploymentResponse.value)
    }
    else {
        @($deploymentResponse)
    }
}

$modelResults = [System.Collections.Generic.List[object]]::new()
foreach ($model in $requestedModels) {
    $matchingEntries = @(
        $catalogItems | Where-Object {
            $entryName = if ($null -ne $_.PSObject.Properties["model"]) { [string]$_.model.name } else { [string]$_.name }
            $entryVersion = if ($null -ne $_.PSObject.Properties["model"]) { [string]$_.model.version } else { [string]$_.version }
            $entryName -eq $model.name -and $entryVersion -eq $model.version
        }
    )
    $supportsSku = $false
    foreach ($entry in $matchingEntries) {
        $skus = @()
        if ($null -ne $entry.PSObject.Properties["skus"]) {
            $skus += @($entry.skus)
        }
        if ($null -ne $entry.PSObject.Properties["model"]) {
            $modelMetadata = $entry.model
            if ($null -ne $modelMetadata -and $null -ne $modelMetadata.PSObject.Properties["skus"]) {
                $skus += @($modelMetadata.skus)
            }
        }
        if (@($skus | Where-Object { [string]$_.name -eq $model.sku }).Count -gt 0) {
            $supportsSku = $true
            break
        }
    }

    $usageName = "OpenAI.$($model.sku).$($model.name)"
    $usageEntry = @($usageItems | Where-Object { [string]$_.name.value -eq $usageName }) | Select-Object -First 1
    $current = if ($null -ne $usageEntry) { [double]$usageEntry.currentValue } else { 0 }
    $limit = if ($null -ne $usageEntry) { [double]$usageEntry.limit } else { 0 }
    $available = $limit - $current
    $existingDeployment = @(
        $existingDeployments | Where-Object { [string]$_.name -eq $model.deployment_name }
    ) | Select-Object -First 1
    $existingCapacity = 0
    $existingMatchesModel = $false
    if ($null -ne $existingDeployment) {
        $existingProperties = if ($null -ne $existingDeployment.PSObject.Properties["properties"]) {
            $existingDeployment.properties
        }
        else {
            $null
        }
        $existingSku = if ($null -ne $existingDeployment.PSObject.Properties["sku"]) {
            $existingDeployment.sku
        }
        else {
            $null
        }
        if ($null -ne $existingProperties -and
            $null -ne $existingProperties.PSObject.Properties["model"] -and
            $null -ne $existingSku) {
            $existingModel = $existingProperties.model
            $existingCapacity = [double]$existingSku.capacity
            $existingMatchesModel = (
                [string]$existingModel.name -eq $model.name -and
                [string]$existingModel.version -eq $model.version -and
                [string]$existingSku.name -eq $model.sku
            )
        }
    }
    $additionalCapacity = if ($existingMatchesModel) {
        [Math]::Max(0, [double]$model.capacity - $existingCapacity)
    }
    else {
        [double]$model.capacity
    }
    $status = if ($supportsSku -and $available -ge $additionalCapacity) { "pass" } else { "fail" }
    $detail = if (-not $supportsSku) {
        "$($model.name) version $($model.version) does not advertise $($model.sku) in $Location."
    }
    elseif ($null -eq $usageEntry) {
        "No exact quota bucket '$usageName' was returned in $Location."
    }
    elseif ($available -lt $additionalCapacity) {
        "Quota bucket '$usageName' has $available available; incremental capacity $additionalCapacity is required."
    }
    elseif ($existingMatchesModel -and $additionalCapacity -eq 0) {
        "Existing deployment '$($model.deployment_name)' already owns capacity $existingCapacity for the requested model/version/SKU; no incremental quota is required."
    }
    else {
        "$($model.name) $($model.version) supports $($model.sku); quota '$usageName' has $available available of $limit and incremental capacity $additionalCapacity is required."
    }
    Add-Check -Name "model:$($model.name)" -Status $status -Detail $detail
    [void]$modelResults.Add([pscustomobject]@{
            deployment_name = $model.deployment_name
            name            = $model.name
            version         = $model.version
            sku             = $model.sku
            capacity        = $model.capacity
            quota_name      = $usageName
            quota_current   = $current
            quota_limit     = $limit
            quota_available = $available
            existing_capacity = $existingCapacity
            additional_capacity_required = $additionalCapacity
            status          = $status
        })
}

$overallStatus = if (@($checks | Where-Object status -eq "fail").Count -eq 0) { "pass" } else { "fail" }
$report = [pscustomobject]@{
    generated_at        = (Get-Date).ToUniversalTime().ToString("o")
    overall_status      = $overallStatus
    subscription_id     = $SubscriptionId
    resource_group_name = $ResourceGroupName
    location            = $Location
    caller_object_id    = $callerObjectId
    checks              = $checks
    models              = $modelResults
}
Write-JsonAtomically -Value $report -Path $OutputPath
$report | ConvertTo-Json -Depth 12

if ($overallStatus -ne "pass") {
    exit 2
}

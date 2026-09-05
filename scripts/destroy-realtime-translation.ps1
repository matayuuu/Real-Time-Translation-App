#requires -Version 7.0

[CmdletBinding()]
param(
    [string]$SubscriptionId,
    [string]$ResourceGroupName,
    [ValidateSet("eastus2")]
    [string]$Location,
    [switch]$AutoApprove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptName = Split-Path -Leaf $PSCommandPath
$RepoRoot = Split-Path -Parent $PSScriptRoot
$InfraDir = Join-Path $RepoRoot "infra\realtime-translation"
$StateDir = Join-Path $RepoRoot ".realtime-translation"
$ContextPath = Join-Path $StateDir "context.json"
$PlanPath = Join-Path $StateDir "realtime-translation-destroy.tfplan"
$StatePath = Join-Path $InfraDir "terraform.tfstate"

function Assert-CommandAvailable {
    param([Parameter(Mandatory)][string]$Name)
    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$ScriptName requires '$Name' on PATH."
    }
}

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][int]$MaxAttempts,
        [Parameter(Mandatory)][int]$DelaySeconds,
        [Parameter(Mandatory)][scriptblock]$Operation,
        [Parameter(Mandatory)][string]$Description
    )
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        & $Operation
        if ($LASTEXITCODE -eq 0) {
            return
        }
        if ($attempt -eq $MaxAttempts) {
            throw "$Description failed after $MaxAttempts attempt(s)."
        }
        Write-Warning "$Description failed on attempt $attempt; retrying in $DelaySeconds second(s)."
        Start-Sleep -Seconds $DelaySeconds
    }
}

foreach ($tool in @("az", "terraform")) {
    Assert-CommandAvailable -Name $tool
}
if (-not (Test-Path -PathType Container $InfraDir)) {
    throw "Isolated Terraform root was not found: $InfraDir"
}
if (-not (Test-Path -PathType Leaf $StatePath)) {
    throw (
        "Isolated Terraform state '$StatePath' was not found. Refusing to remove context or target Azure resources " +
        "without the state that owns them."
    )
}

$context = $null
if (Test-Path -PathType Leaf $ContextPath) {
    $context = Get-Content -Raw -Path $ContextPath | ConvertFrom-Json
    $realtimeTranslationProperty = $context.PSObject.Properties["realtime_translation"]
    if ($null -ne $realtimeTranslationProperty) {
        $realtimeTranslation = $realtimeTranslationProperty.Value
        if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
            $SubscriptionId = [string]$realtimeTranslation.subscription_id
        }
        if ([string]::IsNullOrWhiteSpace($ResourceGroupName)) {
            $ResourceGroupName = [string]$realtimeTranslation.resource_group_name
        }
        if ([string]::IsNullOrWhiteSpace($Location)) {
            $Location = [string]$realtimeTranslation.location
        }
    }
}
if ([string]::IsNullOrWhiteSpace($SubscriptionId) -or
    [string]::IsNullOrWhiteSpace($ResourceGroupName) -or
    [string]::IsNullOrWhiteSpace($Location)) {
    throw "Specify SubscriptionId, ResourceGroupName, and Location, or restore a context.json realtime_translation block."
}

$activeSubscription = & az account show --query id --output tsv
if ($LASTEXITCODE -ne 0) {
    throw "Could not determine the active Azure subscription. Run 'az login' first."
}
if (($activeSubscription -join "`n").Trim() -ne $SubscriptionId) {
    throw "Active Azure subscription does not match '$SubscriptionId'. Run 'az account set --subscription $SubscriptionId' and retry."
}
$callerIdLines = & az ad signed-in-user show --query id --output tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($callerIdLines -join "`n"))) {
    throw "Could not resolve the signed-in Entra user object ID required by the isolated Terraform configuration."
}
$callerObjectId = ($callerIdLines -join "`n").Trim()

$terraformVariables = @(
    "-var", "subscription_id=$SubscriptionId",
    "-var", "resource_group_name=$ResourceGroupName",
    "-var", "location=$Location",
    "-var", "participant_object_id=$callerObjectId"
)
Write-Host "==> Initializing the isolated Terraform root..."
Invoke-WithRetry -MaxAttempts 3 -DelaySeconds 5 -Description "Terraform init" -Operation {
    & terraform "-chdir=$InfraDir" init -input=false -upgrade=false
}

Write-Host "==> Creating saved destroy plan (the existing resource group is not in this state)..."
& terraform "-chdir=$InfraDir" plan -destroy -input=false "-out=$PlanPath" @terraformVariables
if ($LASTEXITCODE -ne 0) {
    throw "Terraform destroy plan failed; no resource was deleted."
}
& terraform "-chdir=$InfraDir" show -no-color $PlanPath
if ($LASTEXITCODE -ne 0) {
    throw "Terraform could not display the saved destroy plan '$PlanPath'."
}

if (-not $AutoApprove) {
    $confirmation = Read-Host "Type DESTROY to delete only the resources in this saved destroy plan"
    if ($confirmation -cne "DESTROY") {
        throw "Destroy cancelled. No Terraform destroy was performed."
    }
}

Write-Host "==> Applying the exact saved destroy plan..."
& terraform "-chdir=$InfraDir" apply -input=false $PlanPath
if ($LASTEXITCODE -ne 0) {
    throw "Terraform destroy failed. Isolated state and context were retained for a safe retry."
}

if ($null -ne $context -and $null -ne $context.PSObject.Properties["realtime_translation"]) {
    $context.PSObject.Properties.Remove("realtime_translation")
    $temporaryPath = "$ContextPath.$([guid]::NewGuid().ToString('N')).tmp"
    $context | ConvertTo-Json -Depth 16 | Set-Content -Path $temporaryPath -Encoding utf8NoBOM
    Move-Item -Force -Path $temporaryPath -Destination $ContextPath
}
Write-Host "Destroy complete. The existing resource group '$ResourceGroupName' was not deleted."

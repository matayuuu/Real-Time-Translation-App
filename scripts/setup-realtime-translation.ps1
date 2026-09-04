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

    [switch]$AutoApprove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptName = Split-Path -Leaf $PSCommandPath
$RepoRoot = Split-Path -Parent $PSScriptRoot
$InfraDir = Join-Path $RepoRoot "infra\realtime-translation"
$StateDir = Join-Path $RepoRoot ".realtime-translation"
$PreflightReport = Join-Path $StateDir "realtime-translation-preflight.json"
$PlanPath = Join-Path $StateDir "realtime-translation.tfplan"

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

function Write-JsonAtomically {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string]$Path
    )

    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $Value | ConvertTo-Json -Depth 16 | Set-Content -Path $temporaryPath -Encoding utf8NoBOM
    Move-Item -Force -Path $temporaryPath -Destination $Path
}

foreach ($tool in @("az", "terraform")) {
    Assert-CommandAvailable -Name $tool
}
if (-not (Test-Path -PathType Container $InfraDir)) {
    throw "Isolated Terraform root was not found: $InfraDir"
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
Write-Host "==> Running read-only preflight..."
& (Join-Path $PSScriptRoot "realtime-translation-preflight.ps1") `
    -SubscriptionId $SubscriptionId `
    -ResourceGroupName $ResourceGroupName `
    -Location $Location `
    -OutputPath $PreflightReport
if ($LASTEXITCODE -ne 0) {
    throw "Preflight failed. Review the non-secret report at '$PreflightReport'; no Azure resources were changed."
}
$preflight = Get-Content -Raw -Path $PreflightReport | ConvertFrom-Json
$callerObjectId = [string]$preflight.caller_object_id
if ([string]::IsNullOrWhiteSpace($callerObjectId)) {
    throw "Preflight report '$PreflightReport' did not contain caller_object_id; refusing to plan role assignments."
}

$terraformVariables = @(
    "-var", "subscription_id=$SubscriptionId",
    "-var", "resource_group_name=$ResourceGroupName",
    "-var", "location=$Location",
    "-var", "participant_object_id=$callerObjectId"
)

Write-Host "==> Initializing isolated Terraform state..."
Invoke-WithRetry -MaxAttempts 3 -DelaySeconds 5 -Description "Terraform init" -Operation {
    & terraform "-chdir=$InfraDir" init -input=false -upgrade=false
}

Write-Host "==> Creating saved Terraform plan..."
& terraform "-chdir=$InfraDir" plan -input=false "-out=$PlanPath" @terraformVariables
if ($LASTEXITCODE -ne 0) {
    throw "Terraform plan failed; no apply was attempted."
}
& terraform "-chdir=$InfraDir" show -no-color $PlanPath
if ($LASTEXITCODE -ne 0) {
    throw "Terraform could not display the saved plan '$PlanPath'."
}

if (-not $AutoApprove) {
    $confirmation = Read-Host "Type APPLY to create only the resources in this saved plan"
    if ($confirmation -cne "APPLY") {
        throw "Setup cancelled. No Terraform apply was performed."
    }
}

Write-Host "==> Applying the exact saved Terraform plan..."
& terraform "-chdir=$InfraDir" apply -input=false $PlanPath
if ($LASTEXITCODE -ne 0) {
    throw (
        "Terraform apply failed. The saved plan and isolated state were retained for investigation. " +
        "Apply is not retried because a failed apply can partially change state."
    )
}

$outputsJson = & terraform "-chdir=$InfraDir" output -json
if ($LASTEXITCODE -ne 0) {
    throw "Terraform applied but outputs could not be read; context.json was left unchanged."
}
$outputsPayload = $outputsJson -join "`n"
$outputs = ($outputsPayload | ConvertFrom-Json)

$contextPath = Join-Path $StateDir "context.json"
$context = if (Test-Path -PathType Leaf $contextPath) {
    (Get-Content -Raw -Path $contextPath | ConvertFrom-Json)
}
else {
    [pscustomobject]@{}
}
$realtimeTranslation = [pscustomobject]@{
    schema_version          = 1
    setup_status            = "complete"
    generated_at            = (Get-Date).ToUniversalTime().ToString("o")
    subscription_id         = $SubscriptionId
    resource_group_name     = $ResourceGroupName
    location                = $Location
    ai_services_account_name = $outputs.account_name.value
    openai_endpoint         = $outputs.openai_endpoint.value
    foundry_project_name    = $outputs.project_name.value
    foundry_project_endpoint = $outputs.project_endpoint.value
    translation = [pscustomobject]@{
        deployment_name = $outputs.translation_deployment_name.value
        model_name      = "gpt-realtime-translate"
        model_version   = "2026-05-06"
        sku             = "GlobalStandard"
        capacity        = 5
    }
    transcription = [pscustomobject]@{
        deployment_name = $outputs.transcription_deployment_name.value
        model_name      = "gpt-realtime-whisper"
        model_version   = "2026-05-06"
        sku             = "GlobalStandard"
        capacity        = 5
    }
    insights = [pscustomobject]@{
        deployment_name = $outputs.insights_deployment_name.value
        model_name      = "gpt-5.6-luna"
        model_version   = "2026-07-09"
        sku             = "GlobalStandard"
        capacity        = 30
    }
    model_retirement_date = $outputs.model_retirement_date.value
}
$context | Add-Member -MemberType NoteProperty -Name "realtime_translation" -Value $realtimeTranslation -Force
Write-JsonAtomically -Value $context -Path $contextPath

Write-Host "Setup complete. Keyless endpoints and deployment metadata were merged into '$contextPath'."

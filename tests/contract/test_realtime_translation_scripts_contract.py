"""Behavioral guardrails for PowerShell realtime translation lifecycle scripts."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
README = ROOT / "README.md"
GUIDE = ROOT / "docs" / "realtime-translation-app.md"


def _read(name: str) -> str:
    return (SCRIPTS / name).read_text(encoding="utf-8")


def test_preflight_is_read_only_and_checks_exact_quota_requirements() -> None:
    text = _read("realtime-translation-preflight.ps1")

    assert text.startswith("#requires -Version 7.0")
    assert "Set-StrictMode -Version Latest" in text
    assert '$ErrorActionPreference = "Stop"' in text
    assert "Get-Command $Name" in text
    assert '"account", "show"' in text
    assert '"group", "show"' in text
    assert '"provider", "show"' in text
    assert '"cognitiveservices", "model", "list"' in text
    assert '"cognitiveservices", "usage", "list"' in text
    assert '"cognitiveservices", "account", "deployment", "list"' in text
    assert "OpenAI.$($model.sku).$($model.name)" in text
    assert "$available -ge $additionalCapacity" in text
    assert "$existingMatchesModel" in text
    assert "no incremental quota is required" in text
    assert "gpt-realtime-translate" in text
    assert "gpt-realtime-whisper" in text
    assert "gpt-5.6-luna" in text
    assert "2026-07-09" in text
    assert "existing_account_recoverable" in text
    assert "existing_account_recovery_detail" in text
    assert "existing_terraform_resources" in text
    assert "azapi_resource.ai_services" in text
    assert "azapi_resource.project" in text
    assert "azapi_resource.participant_openai_user" in text
    assert "MD5]::HashData" not in text
    assert ".ComputeHash(" in text
    assert "az provider register" not in text
    assert "az group create" not in text
    assert "az role assignment create" not in text


def test_setup_requires_preflight_shows_saved_plan_and_merges_context_atomically() -> None:
    text = _read("setup-realtime-translation.ps1")

    assert text.startswith("#requires -Version 7.0")
    assert "realtime-translation-preflight.ps1" in text
    assert 'plan -input=false "-out=$PlanPath"' in text
    assert "show -no-color $PlanPath" in text
    assert 'Read-Host "Type APPLY' in text
    assert "Applying the exact saved Terraform plan" in text
    assert "apply -input=false $PlanPath" in text
    assert "Invoke-WithRetry -MaxAttempts 3" in text
    assert "caller_object_id" in text
    assert '"participant_object_id=$callerObjectId"' in text
    assert 'Add-Member -MemberType NoteProperty -Name "realtime_translation"' in text
    assert "ToString('N')).tmp" in text
    assert "Move-Item -Force -Path $temporaryPath -Destination $Path" in text
    assert "schema_version          = 1" in text
    assert 'setup_status            = "complete"' in text
    assert "ai_services_account_name" in text
    assert "openai_endpoint" in text
    assert "foundry_project_name" in text
    assert "foundry_project_endpoint" in text
    assert "model_retirement_date" in text
    assert 'sku             = "GlobalStandard"' in text
    assert "insights_deployment_name" in text
    assert 'model_name      = "gpt-5.6-luna"' in text
    assert "[switch]$RecoverExisting" in text
    assert '"-chdir=$InfraDir" state list' in text
    assert '"-chdir=$InfraDir" import -input=false' in text
    assert "existing_terraform_resources" in text
    assert "Matching Azure resources already exist but are absent from local Terraform state" in text
    assert text.index('"-chdir=$InfraDir" import -input=false') < text.index(
        'plan -input=false "-out=$PlanPath"'
    )


def test_destroy_uses_isolated_state_and_cleans_context_only_after_apply() -> None:
    text = _read("destroy-realtime-translation.ps1")

    assert text.startswith("#requires -Version 7.0")
    assert 'Join-Path $RepoRoot "infra\\realtime-translation"' in text
    assert 'Join-Path $InfraDir "terraform.tfstate"' in text
    assert "Refusing to remove context" in text
    assert 'plan -destroy -input=false "-out=$PlanPath"' in text
    assert 'Read-Host "Type DESTROY' in text
    assert "apply -input=false $PlanPath" in text
    assert "az ad signed-in-user show --query id --output tsv" in text
    assert '"participant_object_id=$callerObjectId"' in text
    remove_index = text.index('Properties.Remove("realtime_translation")')
    apply_index = text.index('& terraform "-chdir=$InfraDir" apply -input=false $PlanPath')
    assert remove_index > apply_index
    assert "az group delete" not in text
    assert "az provider register" not in text


def test_readme_documents_opt_in_local_state_recovery() -> None:
    readme = README.read_text(encoding="utf-8")
    guide = GUIDE.read_text(encoding="utf-8")

    for text in (readme, guide):
        assert "-RecoverExisting" in text
        assert "terraform.tfstate" in text
        assert "context.json" in text
        assert "pwsh -NoProfile -File" in text

    assert '"generated_at"' in guide
    assert '"foundry_project_endpoint"' in guide
    assert '"model_retirement_date"' in guide
    assert "`insights` は" in guide

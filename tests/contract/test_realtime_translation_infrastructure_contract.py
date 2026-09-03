"""Static contracts for the isolated Teams realtime translation Terraform root."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra" / "realtime-translation"


def _read(name: str) -> str:
    return (INFRA / name).read_text(encoding="utf-8")


def _all_terraform() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in INFRA.glob("*.tf"))


def test_isolated_root_uses_azapi_only_and_reads_the_existing_resource_group() -> None:
    terraform = _all_terraform()

    assert 'version = "~> 2.0"' in _read("versions.tf")
    assert "skip_provider_registration = true" in _read("providers.tf")
    data = _read("data.tf")
    assert 'data "azapi_resource" "target_resource_group"' in data
    assert "Microsoft.Resources/resourceGroups@2024-03-01" in data
    assert 'parent_id = "/subscriptions/${var.subscription_id}"' in data
    assert 'source  = "hashicorp/azurerm"' not in terraform
    assert 'provider "azurerm"' not in terraform
    assert 'data "azurerm_' not in terraform
    assert 'resource "azurerm_' not in terraform
    assert 'resource "azurerm_resource_group"' not in terraform


def test_foundry_account_is_public_keyless_and_deterministically_named() -> None:
    account = _read("foundry_account.tf")
    locals_text = _read("locals.tf")

    assert "Microsoft.CognitiveServices/accounts@2026-05-01" in account
    assert 'kind = "AIServices"' in account
    assert 'name = "S0"' in account
    assert "allowProjectManagement = true" in account
    assert "disableLocalAuth       = true" in account
    assert 'publicNetworkAccess    = "Enabled"' in account
    assert 'defaultAction = "Allow"' in account
    assert 'account_name = lower("aif-rta-${local.name_suffix}")' in locals_text
    assert "name_seed" in locals_text
    assert '"${var.subscription_id}-${var.resource_group_name}-${var.location}"' in locals_text


def test_project_deployments_and_model_contract_are_approved_values() -> None:
    terraform = _all_terraform()
    variables = _read("variables.tf")
    deployments = _read("foundry_deployments.tf")

    assert "Microsoft.CognitiveServices/accounts/projects@2026-05-01" in terraform
    assert 'project_name == "realtime-translation"' in variables
    for name in ("gpt-realtime-translate", "gpt-realtime-whisper", "2026-05-06", "GlobalStandard"):
        assert name in variables
    assert re.search(r"capacity\s*=\s*5", variables)
    assert "depends_on = [azapi_resource.project]" in deployments
    assert "depends_on = [azapi_resource.translation_deployment]" in deployments
    assert 'model_retirement_date = "2027-05-06"' in _read("terraform.tfvars.example")


def test_role_assignments_are_resource_scoped_and_use_stable_role_ids() -> None:
    rbac = _read("rbac.tf")
    locals_text = _read("locals.tf")

    assert "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd" in locals_text
    assert "53ca6127-db72-4b80-b1b0-d745d6d5456d" in locals_text
    assert "eadc314b-1a2d-4efa-be10-5d325db5065e" in locals_text
    assert rbac.count('type      = "Microsoft.Authorization/roleAssignments@2022-04-01"') == 3
    assert rbac.count("parent_id = azapi_resource.ai_services.id") == 1
    assert rbac.count("parent_id = azapi_resource.project.id") == 2
    assert rbac.count('uuidv5("url"') == 3
    assert rbac.count('principalType    = "User"') == 3
    assert "scope              =" not in rbac


def test_no_disallowed_infrastructure_or_sensitive_outputs_are_present() -> None:
    terraform = _all_terraform().lower()
    outputs = _read("outputs.tf").lower()

    for forbidden in (
        'resource "azurerm_resource_group"',
        "microsoft.documentdb",
        "microsoft.containerregistry",
    ):
        assert forbidden not in terraform
    for secret_marker in ("primary_key", "secondary_key", "connection_string", "listkeys"):
        assert secret_marker not in outputs


def test_openai_output_is_the_resource_root_for_the_electron_client() -> None:
    outputs = _read("outputs.tf")

    assert 'value       = "https://${azapi_resource.ai_services.name}.openai.azure.com"' in outputs
    assert "/openai/v1" not in outputs


def test_participant_identity_is_an_explicit_validated_input() -> None:
    variables = _read("variables.tf")

    participant_block = variables.split('variable "participant_object_id"', 1)[1].split(
        'variable "translation_model"', 1
    )[0]
    assert "default" not in participant_block
    assert "Entra user object ID GUID" in participant_block

variable "subscription_id" {
  description = "Subscription containing the existing target resource group."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a GUID."
  }
}

variable "resource_group_name" {
  description = "Existing resource group in which this isolated root creates resources."
  type        = string

  validation {
    condition     = length(trimspace(var.resource_group_name)) > 0
    error_message = "resource_group_name must not be empty."
  }
}

variable "location" {
  description = "Resource location. It intentionally does not inherit the resource group's metadata location."
  type        = string
  default     = "eastus2"

  validation {
    condition     = lower(var.location) == "eastus2"
    error_message = "This approved realtime translation deployment is supported only in eastus2."
  }
}

variable "project_name" {
  description = "Name of the Basic Microsoft Foundry project."
  type        = string
  default     = "realtime-translation"

  validation {
    condition     = var.project_name == "realtime-translation"
    error_message = "project_name must remain realtime-translation for this approved companion app."
  }
}

variable "participant_object_id" {
  description = "Entra user object ID to receive resource-scoped runtime and project access. Setup obtains it from its read-only preflight report."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.participant_object_id))
    error_message = "participant_object_id must be an Entra user object ID GUID."
  }
}

variable "translation_model" {
  description = "Translation realtime deployment. Capacity is in thousands of tokens per minute."
  type = object({
    deployment_name = string
    name            = string
    version         = string
    sku             = string
    capacity        = number
  })
  default = {
    deployment_name = "gpt-realtime-translate"
    name            = "gpt-realtime-translate"
    version         = "2026-05-06"
    sku             = "GlobalStandard"
    capacity        = 5
  }

  validation {
    condition = (
      var.translation_model.deployment_name == "gpt-realtime-translate" &&
      var.translation_model.name == "gpt-realtime-translate" &&
      can(regex("^20[0-9]{2}-[0-9]{2}-[0-9]{2}$", var.translation_model.version)) &&
      var.translation_model.sku == "GlobalStandard" &&
      var.translation_model.capacity >= 1 && var.translation_model.capacity <= 10
    )
    error_message = "translation_model must use the approved deployment/model name, GlobalStandard SKU, ISO version, and capacity from 1 through 10."
  }
}

variable "transcription_model" {
  description = "Transcription realtime deployment. Capacity is in thousands of tokens per minute."
  type = object({
    deployment_name = string
    name            = string
    version         = string
    sku             = string
    capacity        = number
  })
  default = {
    deployment_name = "gpt-realtime-whisper"
    name            = "gpt-realtime-whisper"
    version         = "2026-05-06"
    sku             = "GlobalStandard"
    capacity        = 5
  }

  validation {
    condition = (
      var.transcription_model.deployment_name == "gpt-realtime-whisper" &&
      var.transcription_model.name == "gpt-realtime-whisper" &&
      can(regex("^20[0-9]{2}-[0-9]{2}-[0-9]{2}$", var.transcription_model.version)) &&
      var.transcription_model.sku == "GlobalStandard" &&
      var.transcription_model.capacity >= 1 && var.transcription_model.capacity <= 10
    )
    error_message = "transcription_model must use the approved deployment/model name, GlobalStandard SKU, ISO version, and capacity from 1 through 10."
  }
}

variable "insights_model" {
  description = "Text model used to generate Japanese summaries and next actions."
  type = object({
    deployment_name = string
    name            = string
    version         = string
    sku             = string
    capacity        = number
  })
  default = {
    deployment_name = "gpt-5.6-luna"
    name            = "gpt-5.6-luna"
    version         = "2026-07-09"
    sku             = "GlobalStandard"
    capacity        = 30
  }

  validation {
    condition = (
      var.insights_model.deployment_name == "gpt-5.6-luna" &&
      var.insights_model.name == "gpt-5.6-luna" &&
      var.insights_model.version == "2026-07-09" &&
      var.insights_model.sku == "GlobalStandard" &&
      var.insights_model.capacity >= 1 && var.insights_model.capacity <= 1000
    )
    error_message = "insights_model must use gpt-5.6-luna version 2026-07-09, GlobalStandard SKU, and capacity from 1 through 1000."
  }
}

variable "model_retirement_date" {
  description = "Published retirement date for the approved realtime model versions; review before deploying after this date."
  type        = string
  default     = "2027-05-06"

  validation {
    condition     = can(regex("^20[0-9]{2}-[0-9]{2}-[0-9]{2}$", var.model_retirement_date))
    error_message = "model_retirement_date must be an ISO-8601 calendar date."
  }
}

variable "tags" {
  description = "Tags applied to resources created by this isolated Terraform root."
  type        = map(string)
  default = {
    application = "teams-realtime-translation"
    managed-by  = "terraform"
  }
}

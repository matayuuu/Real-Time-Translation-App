import type { RealtimeTranslationContext } from "../../src/shared/contracts";

export function createContext(
  overrides: Partial<RealtimeTranslationContext> = {},
): RealtimeTranslationContext {
  return {
    schema_version: 1,
    setup_status: "complete",
    generated_at: "2026-09-17T00:00:00Z",
    subscription_id: "00000000-0000-0000-0000-000000000000",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    resource_group_name: "rg-test",
    location: "eastus2",
    ai_services_account_name: "aif-test",
    openai_endpoint: "https://aif-test.openai.azure.com",
    foundry_project_name: "test",
    foundry_project_endpoint: "https://aif-test.services.ai.azure.com/api/projects/test",
    translation: {
      deployment_name: "gpt-realtime-translate",
      model_name: "gpt-realtime-translate",
      model_version: "2026-05-06",
      sku: "GlobalStandard",
      capacity: 5,
    },
    transcription: {
      deployment_name: "gpt-realtime-whisper",
      model_name: "gpt-realtime-whisper",
      model_version: "2026-05-06",
      sku: "GlobalStandard",
      capacity: 5,
    },
    model_retirement_date: "2027-05-06",
    ...overrides,
  };
}

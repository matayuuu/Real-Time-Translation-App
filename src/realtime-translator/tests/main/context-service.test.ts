// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseRealtimeTranslationContext } from "../../src/main/context-service";

function validContext(): Record<string, unknown> {
  return {
    unrelated_value: "preserved",
    realtime_translation: {
      schema_version: 1,
      setup_status: "complete",
      generated_at: "2026-09-03T00:00:00.000Z",
      subscription_id: "00000000-0000-0000-0000-000000000000",
      resource_group_name: "rg-realtime-translation-app",
      location: "eastus2",
      ai_services_account_name: "aif-rta-example",
      openai_endpoint: "https://aif-rta-example.openai.azure.com/",
      foundry_project_name: "realtime-translation",
      foundry_project_endpoint:
        "https://aif-rta-example.services.ai.azure.com/api/projects/realtime-translation",
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
      insights: {
        deployment_name: "gpt-5.6-luna",
        model_name: "gpt-5.6-luna",
        model_version: "2026-07-09",
        sku: "GlobalStandard",
        capacity: 30,
      },
      model_retirement_date: "2027-05-06",
    },
  };
}

describe("parseRealtimeTranslationContext", () => {
  it("parses and normalizes a valid keyless context", () => {
    const result = parseRealtimeTranslationContext(validContext());

    expect(result.openai_endpoint).toBe(
      "https://aif-rta-example.openai.azure.com",
    );
    expect(result.translation.capacity).toBe(5);
    expect(result.transcription.deployment_name).toBe("gpt-realtime-whisper");
    expect(result.insights?.deployment_name).toBe("gpt-5.6-luna");
  });

  it("keeps an older context usable without the optional insights model", () => {
    const input = validContext();
    const realtime = input.realtime_translation as Record<string, unknown>;
    delete realtime.insights;

    const result = parseRealtimeTranslationContext(input);

    expect(result.insights).toBeUndefined();
    expect(result.translation.deployment_name).toBe(
      "gpt-realtime-translate",
    );
  });

  it("rejects incomplete setup state", () => {
    const input = validContext();
    const realtime = input.realtime_translation as Record<string, unknown>;
    realtime.setup_status = "partial";

    expect(() => parseRealtimeTranslationContext(input)).toThrow(
      "setup_status must be complete",
    );
  });

  it("rejects non-Azure endpoints", () => {
    const input = validContext();
    const realtime = input.realtime_translation as Record<string, unknown>;
    realtime.openai_endpoint = "https://example.com";

    expect(() => parseRealtimeTranslationContext(input)).toThrow(
      "Azure OpenAI HTTPS host",
    );
  });
});

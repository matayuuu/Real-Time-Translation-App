// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RealtimeTranslationContext } from "../../src/shared/contracts";

const { getToken } = vi.hoisted(() => ({
  getToken: vi.fn().mockResolvedValue({ token: "entra-token" }),
}));
vi.mock("@azure/identity", () => ({
  AzureCliCredential: class {
    public readonly getToken = getToken;
  },
}));

import { TranslationSecretService } from "../../src/main/translation-secret-service";

const context: RealtimeTranslationContext = {
  schema_version: 1,
  setup_status: "complete",
  generated_at: "2026-09-03T00:00:00Z",
  subscription_id: "00000000-0000-0000-0000-000000000000",
  resource_group_name: "rg-realtime-translation-app",
  location: "eastus2",
  ai_services_account_name: "aif-rta-example",
  openai_endpoint: "https://aif-rta-example.openai.azure.com",
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
  model_retirement_date: "2027-05-06",
};

describe("TranslationSecretService", () => {
  beforeEach(() => {
    getToken.mockClear();
  });

  it("requests an Azure translation secret without unsupported session.type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ value: "ephemeral-secret-value", expires_at: 123 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TranslationSecretService().create(context, {
      source: "speaker",
      targetLanguage: "ja",
    });

    expect(result).toMatchObject({
      value: "ephemeral-secret-value",
      endpoint: context.openai_endpoint,
      expiresAt: 123,
    });
    expect(getToken).toHaveBeenCalledWith("https://ai.azure.com/.default");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      session: Record<string, unknown>;
    };
    expect(body.session.type).toBeUndefined();
    expect(body.session.model).toBe("gpt-realtime-translate");
    expect(body.session.audio).toEqual({
      input: {
        transcription: { model: "gpt-realtime-whisper" },
        noise_reduction: null,
      },
      output: { language: "ja" },
    });
    expect(request.headers).toMatchObject({
      Authorization: "Bearer entra-token",
    });
  });

  it("rejects a target language that does not match the separated source", async () => {
    await expect(
      new TranslationSecretService().create(context, {
        source: "microphone",
        targetLanguage: "ja",
      }),
    ).rejects.toThrow("Invalid target language");
  });
});

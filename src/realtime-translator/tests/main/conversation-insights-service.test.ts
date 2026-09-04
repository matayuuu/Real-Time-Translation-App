// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ConversationInsightsService } from "../../src/main/conversation-insights-service";
import type { RealtimeTranslationContext } from "../../src/shared/contracts";

function context(): RealtimeTranslationContext {
  return {
    schema_version: 1,
    setup_status: "complete",
    generated_at: "2026-09-04T08:00:00.000Z",
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
    insights: {
      deployment_name: "gpt-5.6-luna",
      model_name: "gpt-5.6-luna",
      model_version: "2026-07-09",
      sku: "GlobalStandard",
      capacity: 30,
    },
    model_retirement_date: "2027-05-06",
  };
}

describe("ConversationInsightsService", () => {
  it("requests selected Japanese documents without server-side storage", async () => {
    const credential = {
      getToken: vi.fn().mockResolvedValue({ token: "token" }),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary_markdown: "## 概要\n\n価格について合意しました。",
            next_actions_markdown:
              "- [ ] 自分: 見積書を送付する（期限: 2026-09-05）",
          }),
        }),
        { status: 200 },
      ),
    );
    const service = new ConversationInsightsService(credential, fetcher);

    const result = await service.generate(
      context(),
      [
        {
          source: "microphone",
          startedAt: "2026-09-04T08:00:01.000Z",
          elapsedMs: 2_000,
          original: "明日、見積書を送ります。",
          translation: "I will send the quote tomorrow.",
        },
        {
          source: "speaker",
          startedAt: "2026-09-04T08:00:02.000Z",
          elapsedMs: 1_000,
          original: "The price works for us.",
          translation: "その価格で問題ありません。",
        },
      ],
      { summary: true, nextActions: true },
    );

    expect(result).toEqual({
      summary: "## 概要\n\n価格について合意しました。",
      nextActions: "- [ ] 自分: 見積書を送付する（期限: 2026-09-05）",
    });
    expect(credential.getToken).toHaveBeenCalledWith(
      "https://ai.azure.com/.default",
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "https://aif-rta-example.openai.azure.com/openai/v1/responses",
    );
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      reasoning: { effort: "low" },
    });
    const input = JSON.parse(String(request.input)) as {
      transcript: Array<{ speaker: string; japanese_text: string }>;
    };
    expect(input.transcript).toEqual([
      expect.objectContaining({
        speaker: "相手",
        japanese_text: "その価格で問題ありません。",
      }),
      expect.objectContaining({
        speaker: "自分",
        japanese_text: "明日、見積書を送ります。",
      }),
    ]);
    expect(request.text).toMatchObject({
      format: {
        schema: {
          required: ["summary_markdown", "next_actions_markdown"],
          additionalProperties: false,
        },
      },
    });
  });

  it("does not authenticate or call Luna when no document is selected", async () => {
    const credential = {
      getToken: vi.fn(),
    };
    const fetcher = vi.fn<typeof fetch>();
    const service = new ConversationInsightsService(credential, fetcher);

    await expect(
      service.generate(context(), [], {
        summary: false,
        nextActions: false,
      }),
    ).resolves.toEqual({});
    expect(credential.getToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed structured output", async () => {
    const service = new ConversationInsightsService(
      { getToken: vi.fn().mockResolvedValue({ token: "token" }) },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ output_text: "not-json" }), {
            status: 200,
          }),
        ),
    );

    await expect(
      service.generate(
        context(),
        [
          {
            source: "microphone",
            startedAt: "2026-09-04T08:00:00.000Z",
            original: "確認します。",
            translation: "I will check.",
          },
        ],
        { summary: true, nextActions: false },
      ),
    ).rejects.toThrow("not valid structured JSON");
  });

  it("requires the optional Luna context only for document generation", async () => {
    const configuration = context();
    delete configuration.insights;
    const service = new ConversationInsightsService({
      getToken: vi.fn(),
    });

    await expect(
      service.generate(
        configuration,
        [
          {
            source: "speaker",
            startedAt: "2026-09-04T08:00:00.000Z",
            original: "Hello.",
            translation: "こんにちは。",
          },
        ],
        { summary: true, nextActions: false },
      ),
    ).rejects.toThrow("setup を再実行");
  });
});

// @vitest-environment node

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RecordingExportService,
  type ExportDialogs,
} from "../../src/main/recording-export-service";
import type { RealtimeTranslationContext } from "../../src/shared/contracts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

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

function fixedDate(): Date {
  return new Date(2026, 8, 4, 17, 38, 56);
}

function uuidSequence(...values: string[]): () => string {
  return () => {
    const value = values.shift();
    if (!value) {
      throw new Error("Test UUID sequence was exhausted.");
    }
    return value;
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("RecordingExportService", () => {
  it("suggests a different unique MP3 name for every save", async () => {
    const directory = await temporaryDirectory("translator-export-");
    const defaultPaths: string[] = [];
    const dialogs: ExportDialogs = {
      showSaveDialog: vi.fn(async (options) => {
        defaultPaths.push(String(options.defaultPath));
        return {
          canceled: false,
          filePath: join(directory, String(options.defaultPath)),
        };
      }),
      showOpenDialog: vi.fn(),
    };
    const recording = {
      copy: vi.fn(async (_sessionId: string, destinationPath: string) => {
        await writeFile(destinationPath, new Uint8Array([1, 2, 3]));
      }),
    };
    const insights = { generate: vi.fn() };
    const service = new RecordingExportService(
      recording,
      insights,
      context,
      dialogs,
      fixedDate,
      uuidSequence(
        "aaaaaaaa-0000-0000-0000-000000000000",
        "bbbbbbbb-0000-0000-0000-000000000000",
      ),
    );
    const request = {
      sessionId: "session-1",
      options: { summary: false, nextActions: false },
      transcript: [],
    };

    await service.export(request);
    await service.export(request);

    expect(defaultPaths).toEqual([
      "conversation-20260904-173856-aaaaaaaa.mp3",
      "conversation-20260904-173856-bbbbbbbb.mp3",
    ]);
    expect(insights.generate).not.toHaveBeenCalled();
  });

  it("creates one folder containing the MP3 and selected Markdown files", async () => {
    const directory = await temporaryDirectory("translator-bundle-");
    const dialogs: ExportDialogs = {
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: [directory],
      }),
    };
    const recording = {
      copy: vi.fn(async (_sessionId: string, destinationPath: string) => {
        await writeFile(destinationPath, new Uint8Array([4, 5, 6]));
      }),
    };
    const insights = {
      generate: vi.fn().mockResolvedValue({
        summary: "## 概要\n\n合意しました。",
        nextActions: "- [ ] 資料を送る",
      }),
    };
    const service = new RecordingExportService(
      recording,
      insights,
      context,
      dialogs,
      fixedDate,
      uuidSequence(
        "aaaaaaaa-0000-0000-0000-000000000000",
        "bbbbbbbb-0000-0000-0000-000000000000",
      ),
    );

    const result = await service.export({
      sessionId: "session-1",
      options: { summary: true, nextActions: true },
      transcript: [
        {
          source: "speaker",
          startedAt: "2026-09-04T08:00:00.000Z",
          original: "Agreed.",
          translation: "合意しました。",
        },
      ],
    });

    const baseName = "conversation-20260904-173856-aaaaaaaa";
    const outputDirectory = join(directory, baseName);
    expect(result).toEqual({
      canceled: false,
      outputPath: outputDirectory,
      kind: "bundle",
    });
    expect((await readdir(outputDirectory)).sort()).toEqual([
      `${baseName}-next-actions.md`,
      `${baseName}-summary.md`,
      `${baseName}.mp3`,
    ]);
    expect(await readFile(join(outputDirectory, `${baseName}.mp3`))).toEqual(
      Buffer.from([4, 5, 6]),
    );
    expect(
      await readFile(
        join(outputDirectory, `${baseName}-summary.md`),
        "utf8",
      ),
    ).toContain("# 会話の要約");
    expect(
      await readFile(
        join(outputDirectory, `${baseName}-next-actions.md`),
        "utf8",
      ),
    ).toContain("# Next Actions");
  });

  it("does not write an unselected Markdown document", async () => {
    const directory = await temporaryDirectory("translator-selection-");
    const service = new RecordingExportService(
      {
        copy: async (_sessionId, destinationPath) => {
          await writeFile(destinationPath, new Uint8Array([1]));
        },
      },
      {
        generate: vi.fn().mockResolvedValue({
          summary: "## 概要\n\n内容",
          nextActions: "- [ ] 保存されない項目",
        }),
      },
      context,
      {
        showSaveDialog: vi.fn(),
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [directory],
        }),
      },
      fixedDate,
      uuidSequence(
        "aaaaaaaa-0000-0000-0000-000000000000",
        "bbbbbbbb-0000-0000-0000-000000000000",
      ),
    );

    const result = await service.export({
      sessionId: "session-1",
      options: { summary: true, nextActions: false },
      transcript: [
        {
          source: "microphone",
          startedAt: "2026-09-04T08:00:00.000Z",
          original: "確認します。",
          translation: "I will check.",
        },
      ],
    });

    const outputPath = result.outputPath;
    if (!outputPath) {
      throw new Error("Expected a bundle output path.");
    }
    expect(await readdir(outputPath)).toEqual(
      expect.arrayContaining([
        "conversation-20260904-173856-aaaaaaaa-summary.md",
        "conversation-20260904-173856-aaaaaaaa.mp3",
      ]),
    );
    expect(
      (await readdir(outputPath)).some((name) =>
        name.endsWith("-next-actions.md"),
      ),
    ).toBe(false);
  });

  it("removes a partial temporary folder when file export fails", async () => {
    const directory = await temporaryDirectory("translator-cleanup-");
    const dialogs: ExportDialogs = {
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: [directory],
      }),
    };
    const recording = {
      copy: vi.fn(async (_sessionId: string, destinationPath: string) => {
        await writeFile(destinationPath, new Uint8Array([1]));
        throw new Error("copy failed");
      }),
    };
    const service = new RecordingExportService(
      recording,
      {
        generate: vi.fn().mockResolvedValue({ summary: "## 概要\n\n内容" }),
      },
      context,
      dialogs,
      fixedDate,
      vi
        .fn()
        .mockReturnValueOnce("aaaaaaaa-0000-0000-0000-000000000000")
        .mockReturnValueOnce("bbbbbbbb-0000-0000-0000-000000000000"),
    );

    await expect(
      service.export({
        sessionId: "session-1",
        options: { summary: true, nextActions: false },
        transcript: [
          {
            source: "microphone",
            startedAt: "2026-09-04T08:00:00.000Z",
            original: "確認します。",
            translation: "I will check.",
          },
        ],
      }),
    ).rejects.toThrow("copy failed");
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not call Luna after the folder picker is canceled", async () => {
    const insights = { generate: vi.fn() };
    const service = new RecordingExportService(
      { copy: vi.fn() },
      insights,
      context,
      {
        showSaveDialog: vi.fn(),
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: true,
          filePaths: [],
        }),
      },
      fixedDate,
      () => "aaaaaaaa-0000-0000-0000-000000000000",
    );

    await expect(
      service.export({
        sessionId: "session-1",
        options: { summary: true, nextActions: false },
        transcript: [],
      }),
    ).resolves.toEqual({ canceled: true });
    expect(insights.generate).not.toHaveBeenCalled();
  });
});

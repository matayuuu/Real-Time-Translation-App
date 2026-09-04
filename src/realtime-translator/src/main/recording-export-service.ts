import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dialog } from "electron";

import type {
  ConversationExportOptions,
  ConversationTranscriptEntry,
  ExportRecordingRequest,
  ExportRecordingResult,
  RealtimeTranslationContext,
} from "../shared/contracts";

export interface ExportDialogs {
  showSaveDialog(
    options: Electron.SaveDialogOptions,
  ): Promise<Electron.SaveDialogReturnValue>;
  showOpenDialog(
    options: Electron.OpenDialogOptions,
  ): Promise<Electron.OpenDialogReturnValue>;
}

interface RecordingSource {
  copy(sessionId: string, destinationPath: string): Promise<void>;
}

interface InsightsGenerator {
  generate(
    context: RealtimeTranslationContext,
    transcript: ConversationTranscriptEntry[],
    options: ConversationExportOptions,
  ): Promise<{ summary?: string; nextActions?: string }>;
}

const DEFAULT_DIALOGS: ExportDialogs = {
  showSaveDialog: (options) => dialog.showSaveDialog(options),
  showOpenDialog: (options) => dialog.showOpenDialog(options),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function validateRequest(request: ExportRecordingRequest): void {
  if (
    !isRecord(request) ||
    typeof request.sessionId !== "string" ||
    request.sessionId === "" ||
    !isRecord(request.options) ||
    typeof request.options.summary !== "boolean" ||
    typeof request.options.nextActions !== "boolean" ||
    !Array.isArray(request.transcript)
  ) {
    throw new Error("Invalid recording export request.");
  }
}

function formatTimestamp(date: Date): string {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((value) => value.toString().padStart(2, "0"));
  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

function documentContent(
  title: string,
  body: string,
  generatedAt: Date,
  modelName: string,
): string {
  return `# ${title}

- 生成日時: ${generatedAt.toISOString()}
- 生成モデル: ${modelName}

${body.trim()}
`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

export class RecordingExportService {
  public constructor(
    private readonly recordingService: RecordingSource,
    private readonly insightsService: InsightsGenerator,
    private readonly contextProvider: () => RealtimeTranslationContext | null,
    private readonly dialogs: ExportDialogs = DEFAULT_DIALOGS,
    private readonly now: () => Date = () => new Date(),
    private readonly uuid: () => string = randomUUID,
  ) {}

  public async export(
    request: ExportRecordingRequest,
  ): Promise<ExportRecordingResult> {
    validateRequest(request);
    const bundleRequested =
      request.options.summary || request.options.nextActions;
    const generatedAt = this.now();
    let baseName = this.createBaseName(generatedAt);

    if (!bundleRequested) {
      const result = await this.dialogs.showSaveDialog({
        title: "会話音声を保存",
        defaultPath: `${baseName}.mp3`,
        filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      await this.recordingService.copy(request.sessionId, result.filePath);
      return {
        canceled: false,
        outputPath: result.filePath,
        kind: "audio",
      };
    }

    const selection = await this.dialogs.showOpenDialog({
      title: "会話ファイルの保存先フォルダーを選択",
      buttonLabel: "ここに保存",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { canceled: true };
    }

    const context = this.contextProvider();
    if (!context) {
      throw new Error(
        "Select a valid .realtime-translation/context.json first.",
      );
    }
    if (!context.insights) {
      throw new Error(
        "Markdown 生成モデルが未設定です。setup を再実行して gpt-5.6-luna を追加してください。",
      );
    }
    const documents = await this.insightsService.generate(
      context,
      request.transcript,
      request.options,
    );
    const summary = request.options.summary ? documents.summary : undefined;
    const nextActions = request.options.nextActions
      ? documents.nextActions
      : undefined;
    if (request.options.summary && !summary) {
      throw new Error("Document generation did not return the summary.");
    }
    if (request.options.nextActions && !nextActions) {
      throw new Error("Document generation did not return the next actions.");
    }

    const parentDirectory = selection.filePaths[0];
    if (!parentDirectory) {
      throw new Error("Folder selection did not return a destination path.");
    }
    let finalDirectory = join(parentDirectory, baseName);
    for (let attempt = 0; await pathExists(finalDirectory); attempt += 1) {
      if (attempt >= 9) {
        throw new Error("Could not allocate a unique export folder name.");
      }
      baseName = this.createBaseName(generatedAt);
      finalDirectory = join(parentDirectory, baseName);
    }
    const temporaryDirectory = join(
      parentDirectory,
      `.${baseName}.${this.uuid()}.tmp`,
    );
    await mkdir(temporaryDirectory, { recursive: false });

    try {
      await this.recordingService.copy(
        request.sessionId,
        join(temporaryDirectory, `${baseName}.mp3`),
      );
      if (summary) {
        await writeFile(
          join(temporaryDirectory, `${baseName}-summary.md`),
          documentContent(
            "会話の要約",
            summary,
            generatedAt,
            context.insights.model_name,
          ),
          { encoding: "utf8", flag: "wx" },
        );
      }
      if (nextActions) {
        await writeFile(
          join(temporaryDirectory, `${baseName}-next-actions.md`),
          documentContent(
            "Next Actions",
            nextActions,
            generatedAt,
            context.insights.model_name,
          ),
          { encoding: "utf8", flag: "wx" },
        );
      }
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      try {
        await rm(temporaryDirectory, { force: true, recursive: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [toError(error), toError(cleanupError)],
          "Conversation export and cleanup both failed.",
        );
      }
      throw error;
    }

    return {
      canceled: false,
      outputPath: finalDirectory,
      kind: "bundle",
    };
  }

  private createBaseName(date: Date): string {
    if (!Number.isFinite(date.getTime())) {
      throw new Error("Cannot generate an export name from an invalid date.");
    }
    const suffix = this.uuid().replaceAll("-", "").slice(0, 8).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(suffix)) {
      throw new Error("Cannot generate a valid unique export identifier.");
    }
    return `conversation-${formatTimestamp(date)}-${suffix}`;
  }
}

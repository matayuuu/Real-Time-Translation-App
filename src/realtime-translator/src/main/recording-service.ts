import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { dialog } from "electron";

import type {
  RecordingAppendPayload,
  RecordingSessionInfo,
  RecordingStopResult,
  RecordingTrack,
  SaveRecordingRequest,
  SaveRecordingResult,
} from "../shared/contracts";

const TRACKS: readonly RecordingTrack[] = [
  "speaker",
  "microphone",
  "mix",
];
const MAX_CHUNK_BYTES = 1_048_576;

interface RecordingSession {
  id: string;
  directory: string;
  startedAt: string;
  sampleRate: number;
  state: "recording" | "stopped";
  writeChain: Promise<void>;
}

function isTrack(value: string): value is RecordingTrack {
  return TRACKS.includes(value as RecordingTrack);
}

export class RecordingService {
  private readonly sessions = new Map<string, RecordingSession>();

  public constructor(private readonly recordingsRoot: string) {}

  public async initialize(): Promise<void> {
    await mkdir(this.recordingsRoot, { recursive: true });
    await this.removeAbandonedRecordings();
  }

  public async start(sampleRate: number): Promise<RecordingSessionInfo> {
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate < 8_000 ||
      sampleRate > 96_000
    ) {
      throw new Error(`Unsupported recording sample rate: ${sampleRate}.`);
    }

    const id = randomUUID();
    const directory = join(this.recordingsRoot, id);
    const startedAt = new Date().toISOString();
    await mkdir(directory, { recursive: false });
    await Promise.all(
      TRACKS.map((track) => writeFile(this.trackPath(directory, track), "")),
    );

    this.sessions.set(id, {
      id,
      directory,
      startedAt,
      sampleRate,
      state: "recording",
      writeChain: Promise.resolve(),
    });

    return { sessionId: id, startedAt, sampleRate };
  }

  public async append(payload: RecordingAppendPayload): Promise<void> {
    const session = this.requireSession(payload.sessionId);
    if (session.state !== "recording") {
      throw new Error("Recording session has already stopped.");
    }
    if (!isTrack(payload.track)) {
      throw new Error(`Unknown recording track: ${String(payload.track)}.`);
    }
    if (!(payload.chunk instanceof Uint8Array)) {
      throw new Error("Recording chunk must be a Uint8Array.");
    }
    if (payload.chunk.byteLength > MAX_CHUNK_BYTES) {
      throw new Error(
        `Recording chunk exceeds ${MAX_CHUNK_BYTES} bytes.`,
      );
    }

    const bytes = Buffer.from(
      payload.chunk.buffer,
      payload.chunk.byteOffset,
      payload.chunk.byteLength,
    );
    const path = this.trackPath(session.directory, payload.track);
    session.writeChain = session.writeChain.then(async () => {
      await appendFile(path, bytes);
    });
    await session.writeChain;
  }

  public async stop(sessionId: string): Promise<RecordingStopResult> {
    const session = this.requireSession(sessionId);
    await session.writeChain;
    session.state = "stopped";

    const entries = await Promise.all(
      TRACKS.map(async (track) => {
        const fileStat = await stat(this.trackPath(session.directory, track));
        return [track, { byteLength: fileStat.size }] as const;
      }),
    );

    return {
      sessionId,
      tracks: Object.fromEntries(entries) as RecordingStopResult["tracks"],
    };
  }

  public async save(
    request: SaveRecordingRequest,
  ): Promise<SaveRecordingResult> {
    const session = this.requireSession(request.sessionId);
    if (session.state !== "stopped") {
      throw new Error("Stop the recording before saving an MP3.");
    }
    if (!isTrack(request.track)) {
      throw new Error(`Unknown recording track: ${String(request.track)}.`);
    }

    const safeName = basename(request.suggestedName).endsWith(".mp3")
      ? basename(request.suggestedName)
      : `${basename(request.suggestedName)}.mp3`;
    const result = await dialog.showSaveDialog({
      title: "MP3 を保存",
      defaultPath: safeName,
      filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await copyFile(
      this.trackPath(session.directory, request.track),
      result.filePath,
    );
    return { canceled: false, filePath: result.filePath };
  }

  public async discard(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.state !== "stopped") {
      throw new Error("Stop the recording before discarding it.");
    }
    await session.writeChain;
    await rm(session.directory, { recursive: true });
    this.sessions.delete(sessionId);
  }

  private requireSession(sessionId: string): RecordingSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown recording session: ${sessionId}.`);
    }
    return session;
  }

  private trackPath(directory: string, track: RecordingTrack): string {
    return join(directory, `${track}.mp3`);
  }

  private async removeAbandonedRecordings(): Promise<void> {
    const entries = await readdir(this.recordingsRoot, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = resolve(this.recordingsRoot, entry.name);
      const relativePath = relative(resolve(this.recordingsRoot), candidate);
      if (
        relativePath === "" ||
        relativePath.startsWith("..") ||
        isAbsolute(relativePath)
      ) {
        continue;
      }
      await rm(candidate, { recursive: true });
    }
  }
}

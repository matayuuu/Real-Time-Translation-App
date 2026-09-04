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
import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  RecordingAppendPayload,
  RecordingSessionInfo,
  RecordingStopResult,
} from "../shared/contracts";

const MAX_CHUNK_BYTES = 1_048_576;
const RECORDING_FILE_NAME = "conversation.mp3";

interface RecordingSession {
  id: string;
  directory: string;
  startedAt: string;
  sampleRate: number;
  state: "recording" | "stopped";
  writeChain: Promise<void>;
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
    await writeFile(this.recordingPath(directory), "");

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
    if (
      !payload ||
      typeof payload.sessionId !== "string" ||
      payload.sessionId === ""
    ) {
      throw new Error("Invalid recording append payload.");
    }
    const session = this.requireSession(payload.sessionId);
    if (session.state !== "recording") {
      throw new Error("Recording session has already stopped.");
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
    const path = this.recordingPath(session.directory);
    session.writeChain = session.writeChain.then(async () => {
      await appendFile(path, bytes);
    });
    await session.writeChain;
  }

  public async stop(sessionId: string): Promise<RecordingStopResult> {
    const session = this.requireSession(sessionId);
    await session.writeChain;
    session.state = "stopped";

    const fileStat = await stat(this.recordingPath(session.directory));

    return {
      sessionId,
      byteLength: fileStat.size,
    };
  }

  public async copy(sessionId: string, destinationPath: string): Promise<void> {
    if (
      typeof destinationPath !== "string" ||
      !isAbsolute(destinationPath)
    ) {
      throw new Error("Recording destination must be an absolute path.");
    }
    const session = this.requireSession(sessionId);
    if (session.state !== "stopped") {
      throw new Error("Stop the recording before saving an MP3.");
    }
    await session.writeChain;
    const sourcePath = this.recordingPath(session.directory);
    const fileStat = await stat(sourcePath);
    if (fileStat.size === 0) {
      throw new Error("The mixed MP3 recording is empty.");
    }
    await copyFile(sourcePath, destinationPath);
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

  private recordingPath(directory: string): string {
    return join(directory, RECORDING_FILE_NAME);
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

import type {
  RecordingSessionInfo,
  RecordingStopResult,
  RecordingTrack,
} from "@shared/contracts";

import type { PcmBatch } from "../audio/audio-capture";

type WorkerOutput =
  | { type: "ready" }
  | { type: "chunk"; track: RecordingTrack; chunk: Uint8Array }
  | { type: "done" }
  | { type: "error"; message: string };

export class RecordingController {
  private worker: Worker | null = null;
  private session: RecordingSessionInfo | null = null;
  private appendChain: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;
  private failure: Error | null = null;

  public constructor(
    private readonly onError: (message: string) => void = () => undefined,
  ) {}

  public async start(sampleRate: number): Promise<RecordingSessionInfo> {
    if (this.worker || this.session) {
      throw new Error("Recording is already active.");
    }

    this.session = await window.desktop.recording.start(sampleRate);
    try {
      this.worker = new Worker(
        new URL("./mp3-encoder.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
        this.handleWorkerMessage(event.data);
      };
      this.worker.onerror = (event) => {
        this.setFailure(new Error(event.message || "MP3 worker failed."));
      };
      this.worker.postMessage({
        type: "initialize",
        sampleRate,
        bitrate: 128,
      });
      await this.readyPromise;
      return this.session;
    } catch (error) {
      const primaryError =
        error instanceof Error ? error : new Error(String(error));
      const cleanupErrors: Error[] = [];
      try {
        await window.desktop.recording.stop(this.session.sessionId);
      } catch (cleanupFailure) {
        cleanupErrors.push(
          cleanupFailure instanceof Error
            ? cleanupFailure
            : new Error(String(cleanupFailure)),
        );
      }
      if (cleanupErrors.length === 0) {
        try {
          await window.desktop.recording.discard(this.session.sessionId);
        } catch (cleanupFailure) {
          cleanupErrors.push(
            cleanupFailure instanceof Error
              ? cleanupFailure
              : new Error(String(cleanupFailure)),
          );
        }
      }
      this.reset();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          "MP3 encoder initialization and cleanup both failed.",
        );
      }
      throw primaryError;
    }
  }

  public encode(batch: PcmBatch): void {
    if (!this.worker || this.failure) {
      return;
    }
    this.worker.postMessage(
      {
        type: "encode",
        speaker: batch.speaker,
        microphone: batch.microphone,
        mix: batch.mix,
      },
      [batch.speaker.buffer, batch.microphone.buffer, batch.mix.buffer],
    );
  }

  public async stop(): Promise<RecordingStopResult> {
    if (!this.worker || !this.session) {
      throw new Error("Recording is not active.");
    }
    const sessionId = this.session.sessionId;
    let failure = this.failure;
    if (!failure) {
      this.stopPromise = new Promise<void>((resolve, reject) => {
        this.resolveStop = resolve;
        this.rejectStop = reject;
      });
      this.worker.postMessage({ type: "flush" });
      try {
        await this.stopPromise;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    try {
      await this.appendChain;
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }

    let result: RecordingStopResult;
    try {
      result = await window.desktop.recording.stop(sessionId);
    } finally {
      this.reset();
    }
    if (failure) {
      throw failure;
    }
    return result;
  }

  private handleWorkerMessage(message: WorkerOutput): void {
    if (message.type === "ready") {
      this.resolveReady?.();
      return;
    }
    if (message.type === "error") {
      this.setFailure(new Error(message.message));
      return;
    }
    if (message.type === "done") {
      this.resolveStop?.();
      return;
    }
    if (!this.session) {
      return;
    }

    const sessionId = this.session.sessionId;
    this.appendChain = this.appendChain.then(() =>
      window.desktop.recording.append({
        sessionId,
        track: message.track,
        chunk: message.chunk,
      }),
    );
    void this.appendChain.catch((error: unknown) => {
      this.setFailure(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  private setFailure(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.onError(error.message);
    this.rejectReady?.(error);
    this.rejectStop?.(error);
  }

  private reset(): void {
    this.worker?.terminate();
    this.worker = null;
    this.session = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.stopPromise = null;
    this.resolveStop = null;
    this.rejectStop = null;
    this.failure = null;
    this.appendChain = Promise.resolve();
  }
}

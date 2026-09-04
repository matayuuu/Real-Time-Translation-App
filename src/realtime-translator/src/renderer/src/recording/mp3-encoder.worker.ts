/// <reference lib="webworker" />

import { Mp3Encoder } from "@breezystack/lamejs";

import { floatToPcm16 } from "./pcm";

type WorkerInput =
  | { type: "initialize"; sampleRate: number; bitrate: number }
  | { type: "encode"; samples: Float32Array }
  | { type: "flush" };

type WorkerOutput =
  | { type: "ready" }
  | { type: "chunk"; chunk: Uint8Array }
  | { type: "done" }
  | { type: "error"; message: string };

let encoder: Mp3Encoder | null = null;

function emit(message: WorkerOutput, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

function emitEncoded(bytes: Int8Array): void {
  if (bytes.length === 0) {
    return;
  }
  const chunk = new Uint8Array(bytes.length);
  chunk.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  emit({ type: "chunk", chunk }, [chunk.buffer]);
}

self.onmessage = (event: MessageEvent<WorkerInput>): void => {
  try {
    const message = event.data;
    if (message.type === "initialize") {
      if (
        !Number.isInteger(message.sampleRate) ||
        message.sampleRate < 8_000 ||
        message.sampleRate > 96_000
      ) {
        throw new Error(`Unsupported sample rate: ${message.sampleRate}.`);
      }
      encoder = new Mp3Encoder(1, message.sampleRate, message.bitrate);
      emit({ type: "ready" });
      return;
    }

    if (!encoder) {
      throw new Error("MP3 encoder is not initialized.");
    }

    if (message.type === "encode") {
      emitEncoded(encoder.encodeBuffer(floatToPcm16(message.samples)));
      return;
    }

    emitEncoded(encoder.flush());
    encoder = null;
    emit({ type: "done" });
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

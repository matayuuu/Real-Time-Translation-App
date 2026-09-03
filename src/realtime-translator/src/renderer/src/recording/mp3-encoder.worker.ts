/// <reference lib="webworker" />

import { Mp3Encoder } from "@breezystack/lamejs";

import type { RecordingTrack } from "@shared/contracts";

import { floatToPcm16 } from "./pcm";

type EncoderMap = Record<RecordingTrack, Mp3Encoder>;

type WorkerInput =
  | { type: "initialize"; sampleRate: number; bitrate: number }
  | {
      type: "encode";
      speaker: Float32Array;
      microphone: Float32Array;
      mix: Float32Array;
    }
  | { type: "flush" };

type WorkerOutput =
  | { type: "ready" }
  | { type: "chunk"; track: RecordingTrack; chunk: Uint8Array }
  | { type: "done" }
  | { type: "error"; message: string };

let encoders: EncoderMap | null = null;

function emit(message: WorkerOutput, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

function emitEncoded(track: RecordingTrack, bytes: Int8Array): void {
  if (bytes.length === 0) {
    return;
  }
  const chunk = new Uint8Array(bytes.length);
  chunk.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  emit({ type: "chunk", track, chunk }, [chunk.buffer]);
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
      encoders = {
        speaker: new Mp3Encoder(1, message.sampleRate, message.bitrate),
        microphone: new Mp3Encoder(1, message.sampleRate, message.bitrate),
        mix: new Mp3Encoder(1, message.sampleRate, message.bitrate),
      };
      emit({ type: "ready" });
      return;
    }

    if (!encoders) {
      throw new Error("MP3 encoder is not initialized.");
    }

    if (message.type === "encode") {
      const batches: Record<RecordingTrack, Float32Array> = {
        speaker: message.speaker,
        microphone: message.microphone,
        mix: message.mix,
      };
      for (const track of Object.keys(batches) as RecordingTrack[]) {
        emitEncoded(
          track,
          encoders[track].encodeBuffer(floatToPcm16(batches[track])),
        );
      }
      return;
    }

    for (const track of Object.keys(encoders) as RecordingTrack[]) {
      emitEncoded(track, encoders[track].flush());
    }
    encoders = null;
    emit({ type: "done" });
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

import { describe, expect, it } from "vitest";

import {
  parseTranscriptEvent,
  TranslationSession,
} from "../../src/renderer/src/realtime/translation-session";

describe("parseTranscriptEvent", () => {
  it("maps source transcript deltas", () => {
    expect(
      parseTranscriptEvent("speaker", {
        type: "session.input_transcript.delta",
        delta: "Welcome",
        elapsed_ms: 16_000,
      }),
    ).toEqual({
      source: "speaker",
      side: "input",
      kind: "delta",
      text: "Welcome",
      itemId: "stream-1",
      elapsedMs: 16_000,
    });
  });

  it("maps translated transcript deltas", () => {
    expect(
      parseTranscriptEvent("microphone", {
        type: "session.output_transcript.delta",
        delta: "Thank you.",
      }),
    ).toEqual({
      source: "microphone",
      side: "output",
      kind: "delta",
      text: "Thank you.",
    });
  });

  it("uses elapsed time before distinct API item IDs for alignment", () => {
    expect(
      parseTranscriptEvent(
        "speaker",
        {
          type: "session.output_transcript.delta",
          delta: "こんにちは",
          item_id: "output-item",
          elapsed_ms: 12_000,
        },
        "speaker-2",
      ),
    ).toMatchObject({ itemId: "speaker-2-0", elapsedMs: 12_000 });
  });

  it("maps final source transcripts and drops corrupt replacement deltas", () => {
    expect(
      parseTranscriptEvent("microphone", {
        type: "session.input_transcript.delta",
        delta: "�",
        elapsed_ms: 1_000,
      }),
    ).toBeNull();
    expect(
      parseTranscriptEvent("microphone", {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "よろしくお願いします。",
        item_id: "input-item",
      }),
    ).toEqual({
      source: "microphone",
      side: "input",
      kind: "done",
      text: "よろしくお願いします。",
      itemId: "input-item",
    });
  });

  it("ignores unrelated events", () => {
    expect(
      parseTranscriptEvent("speaker", { type: "session.updated" }),
    ).toBeNull();
  });

  it("stops and resumes audio transmission without closing the session", () => {
    const audioTrack = { enabled: true } as MediaStreamTrack;
    const session = new TranslationSession("microphone", audioTrack, {
      onState() {},
      onTranscript() {},
      onFinalize() {},
      onError() {},
    });

    session.pause();
    expect(audioTrack.enabled).toBe(false);

    session.resume();
    expect(audioTrack.enabled).toBe(true);
  });
});

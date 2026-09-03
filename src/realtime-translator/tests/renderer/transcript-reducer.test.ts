import { describe, expect, it } from "vitest";

import {
  EMPTY_TRANSCRIPTS,
  transcriptReducer,
} from "../../src/renderer/src/transcript/reducer";

describe("transcriptReducer", () => {
  it("keeps speaker and microphone entries separated", () => {
    const speakerState = transcriptReducer(EMPTY_TRANSCRIPTS, {
      source: "speaker",
      side: "input",
      kind: "delta",
      text: "Hello",
    });
    const state = transcriptReducer(speakerState, {
      source: "microphone",
      side: "output",
      kind: "delta",
      text: "Thank you",
    });

    expect(state.speaker[0]?.original).toBe("Hello");
    expect(state.microphone[0]?.translation).toBe("Thank you");
  });

  it("replaces a partial value with the final transcript", () => {
    const partial = transcriptReducer(EMPTY_TRANSCRIPTS, {
      source: "speaker",
      side: "input",
      kind: "delta",
      text: "Good",
    });
    const completed = transcriptReducer(partial, {
      source: "speaker",
      side: "input",
      kind: "done",
      text: "Good morning.",
    });

    expect(completed.speaker[0]).toMatchObject({
      original: "Good morning.",
      originalFinal: true,
    });
  });

  it("clears both panes", () => {
    const state = transcriptReducer(EMPTY_TRANSCRIPTS, {
      source: "speaker",
      side: "input",
      kind: "delta",
      text: "Hello",
    });

    expect(transcriptReducer(state, { type: "clear" })).toEqual(
      EMPTY_TRANSCRIPTS,
    );
  });

  it("finalizes a continuous stream when its session closes", () => {
    const state = transcriptReducer(EMPTY_TRANSCRIPTS, {
      source: "speaker",
      side: "input",
      kind: "delta",
      text: "Continuous source",
      itemId: "speaker-1-0",
    });
    const finalized = transcriptReducer(state, {
      type: "finalize-source",
      source: "speaker",
    });

    expect(finalized.speaker[0]).toMatchObject({
      originalFinal: true,
      translationFinal: true,
    });
  });

  it("starts a new aligned entry when elapsed time enters the next bucket", () => {
    const first = transcriptReducer(EMPTY_TRANSCRIPTS, {
      source: "speaker",
      side: "input",
      kind: "delta",
      text: "First",
      itemId: "speaker-1-0",
      elapsedMs: 1_000,
    });
    const second = transcriptReducer(first, {
      source: "speaker",
      side: "output",
      kind: "delta",
      text: "Second",
      itemId: "speaker-1-1",
      elapsedMs: 16_000,
    });

    expect(second.speaker).toHaveLength(2);
    expect(second.speaker[0]).toMatchObject({
      originalFinal: true,
      translationFinal: true,
    });
  });
});

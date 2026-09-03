import { describe, expect, it } from "vitest";

import { Mp3Encoder } from "@breezystack/lamejs";

describe("MP3 encoder dependency", () => {
  it("encodes deterministic PCM into a non-empty MPEG stream", () => {
    const encoder = new Mp3Encoder(1, 48_000, 128);
    const silence = new Int16Array(48_000);
    const chunks: number[] = [];
    for (let offset = 0; offset < silence.length; offset += 1_152) {
      chunks.push(
        ...encoder.encodeBuffer(silence.subarray(offset, offset + 1_152)),
      );
    }
    chunks.push(...encoder.flush());

    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.some((value) => value !== 0)).toBe(true);
    const unsigned = Uint8Array.from(chunks, (value) => value & 0xff);
    expect(
      unsigned.some(
        (value, index) =>
          value === 0xff && ((unsigned[index + 1] ?? 0) & 0xe0) === 0xe0,
      ),
    ).toBe(true);
  });
});

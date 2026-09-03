import { describe, expect, it } from "vitest";

import {
  floatToPcm16,
  mixMono,
} from "../../src/renderer/src/recording/pcm";

describe("PCM helpers", () => {
  it("clamps and converts float samples to signed PCM16", () => {
    expect(
      Array.from(floatToPcm16(new Float32Array([-2, -1, 0, 1, 2]))),
    ).toEqual([-32768, -32768, 0, 32767, 32767]);
  });

  it("creates an aligned half-gain mono mix", () => {
    const mixed = mixMono(
      new Float32Array([1, -1, 0.5]),
      new Float32Array([1, 1, -0.5]),
    );

    expect(Array.from(mixed)).toEqual([1, 0, 0]);
  });

  it("rejects buffers with different lengths", () => {
    expect(() =>
      mixMono(new Float32Array(1), new Float32Array(2)),
    ).toThrow("equal length");
  });
});

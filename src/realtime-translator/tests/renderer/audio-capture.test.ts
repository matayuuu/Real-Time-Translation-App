import { describe, expect, it } from "vitest";

import { calculatePcmLevel } from "../../src/renderer/src/audio/audio-capture";

describe("calculatePcmLevel", () => {
  it("reports silence as zero", () => {
    expect(calculatePcmLevel(new Float32Array(4))).toBe(0);
  });

  it("calculates a normalized RMS level from captured PCM", () => {
    expect(
      calculatePcmLevel(new Float32Array([0.1, -0.1, 0.1, -0.1])),
    ).toBeCloseTo(0.4);
  });

  it("caps loud audio at one", () => {
    expect(calculatePcmLevel(new Float32Array([0.8, -0.8]))).toBe(1);
  });
});

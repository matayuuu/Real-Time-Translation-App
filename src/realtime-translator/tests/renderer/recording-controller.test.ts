import { describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/contracts";
import { RecordingController } from "../../src/renderer/src/recording/recording-controller";

class FailingWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;

  public postMessage(message: { type: string }): void {
    if (message.type === "initialize") {
      queueMicrotask(() => {
        this.onmessage?.(
          new MessageEvent("message", {
            data: { type: "error", message: "encoder unavailable" },
          }),
        );
      });
    }
  }

  public terminate(): void {}
}

describe("RecordingController", () => {
  it("stops and discards a main-process session when encoder startup fails", async () => {
    const stop = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      tracks: {
        speaker: { byteLength: 0 },
        microphone: { byteLength: 0 },
        mix: { byteLength: 0 },
      },
    });
    const discard = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      recording: {
        start: vi.fn().mockResolvedValue({
          sessionId: "session-1",
          startedAt: "2026-09-03T00:00:00Z",
          sampleRate: 48_000,
        }),
        stop,
        discard,
      },
    } as unknown as DesktopBridge;
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: bridge,
    });
    vi.stubGlobal("Worker", FailingWorker);

    await expect(new RecordingController().start(48_000)).rejects.toThrow(
      "encoder unavailable",
    );
    expect(stop).toHaveBeenCalledWith("session-1");
    expect(discard).toHaveBeenCalledWith("session-1");
  });
});

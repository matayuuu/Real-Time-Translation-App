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

class SuccessfulWorker {
  public static latest: SuccessfulWorker | null = null;
  public readonly messages: Array<Record<string, unknown>> = [];
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;

  public constructor() {
    SuccessfulWorker.latest = this;
  }

  public postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    if (message.type === "initialize") {
      queueMicrotask(() => {
        this.onmessage?.(
          new MessageEvent("message", { data: { type: "ready" } }),
        );
      });
    } else if (message.type === "encode") {
      queueMicrotask(() => {
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              type: "chunk",
              chunk: new Uint8Array([1, 2, 3]),
            },
          }),
        );
      });
    } else if (message.type === "flush") {
      queueMicrotask(() => {
        this.onmessage?.(
          new MessageEvent("message", { data: { type: "done" } }),
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
      byteLength: 0,
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

  it("encodes and appends only the mixed PCM stream", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      recording: {
        start: vi.fn().mockResolvedValue({
          sessionId: "session-1",
          startedAt: "2026-09-03T00:00:00Z",
          sampleRate: 48_000,
        }),
        append,
        stop: vi.fn().mockResolvedValue({
          sessionId: "session-1",
          byteLength: 3,
        }),
        discard: vi.fn(),
      },
    } as unknown as DesktopBridge;
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: bridge,
    });
    vi.stubGlobal("Worker", SuccessfulWorker);

    const controller = new RecordingController();
    await controller.start(48_000);
    controller.encode({
      speaker: new Float32Array([0.5, 0]),
      microphone: new Float32Array([0, -0.5]),
      mix: new Float32Array([0.25, -0.25]),
    });
    await Promise.resolve();
    const result = await controller.stop();

    expect(result.byteLength).toBe(3);
    expect(append).toHaveBeenCalledWith({
      sessionId: "session-1",
      chunk: new Uint8Array([1, 2, 3]),
    });
    expect(SuccessfulWorker.latest?.messages).toContainEqual({
      type: "encode",
      samples: new Float32Array([0.25, -0.25]),
    });
  });
});

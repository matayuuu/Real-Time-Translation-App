import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  RecordingStopResult,
} from "../../src/shared/contracts";
import {
  App,
  ExportPanel,
  SessionControls,
  shouldShowConsentNotice,
} from "../../src/renderer/src/App";

const bridge: DesktopBridge = {
  configuration: {
    get: vi.fn().mockResolvedValue(null),
    choose: vi.fn().mockResolvedValue(null),
  },
  translation: {
    createSecret: vi.fn(),
  },
  recording: {
    start: vi.fn(),
    append: vi.fn(),
    stop: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  },
  events: {
    subscribe: vi.fn().mockReturnValue(() => undefined),
  },
};

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: bridge,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  it("shows separated bilingual panes and requires setup", async () => {
    render(<App />);

    expect(
      await screen.findByRole("region", { name: "SPEAKER OUTPUT" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "MICROPHONE INPUT" }),
    ).toBeTruthy();
    expect(screen.getByText("English → 日本語")).toBeTruthy();
    expect(screen.getByText("日本語 → English")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Realtime Translator" }),
    ).toBeTruthy();
    expect(screen.queryByText("相手の発言")).toBeNull();
    expect(screen.queryByText("自分の発言")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "START CONVERSATION",
      })
        .disabled,
    ).toBe(true);
  });

  it("shows consent only before a session starts or after an error", () => {
    expect(shouldShowConsentNotice("idle")).toBe(true);
    expect(shouldShowConsentNotice("error")).toBe(true);
    for (const phase of [
      "starting",
      "running",
      "pausing",
      "paused",
      "resuming",
      "stopping",
      "finished",
    ] as const) {
      expect(shouldShowConsentNotice(phase)).toBe(false);
    }
  });

  it("offers pause and end while running, then resume and end while paused", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <SessionControls
        phase="running"
        canStart={false}
        onStart={vi.fn()}
        onPause={onPause}
        onResume={onResume}
        onStop={onStop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "STOP" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "END SESSION" }),
    ).toBeTruthy();

    rerender(
      <SessionControls
        phase="paused"
        canStart={false}
        onStart={vi.fn()}
        onPause={onPause}
        onResume={onResume}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "RESUME" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "END SESSION" }),
    ).toBeTruthy();
  });

  it("shows an explicit save-or-discard dialog after recording", () => {
    const result: RecordingStopResult = {
      sessionId: "session-1",
      tracks: {
        speaker: { byteLength: 100 },
        microphone: { byteLength: 100 },
        mix: { byteLength: 200 },
      },
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onDiscard = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ExportPanel
        result={result}
        onSave={onSave}
        onDiscard={onDiscard}
        savingTrack={null}
        discarding={false}
        savedPaths={{}}
        error={null}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "録音を保存しますか？" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /SAVE SPEAKER MP3/ }),
    );
    expect(onSave).toHaveBeenCalledWith("speaker");
    expect(
      screen.getByRole("button", { name: "DISCARD & CLOSE" }),
    ).toBeTruthy();

    rerender(
      <ExportPanel
        result={result}
        onSave={onSave}
        onDiscard={onDiscard}
        savingTrack={null}
        discarding={false}
        savedPaths={{ speaker: "C:\\recordings\\speaker.mp3" }}
        error={null}
      />,
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: /SAVED/,
      }).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "DONE" })).toBeTruthy();
  });
});

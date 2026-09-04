import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/contracts";
import {
  App,
  ConversationPane,
  ExportPanel,
  SessionControls,
  mergeTranscriptEntries,
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
    export: vi.fn(),
    discard: vi.fn(),
  },
  events: {
    subscribe: vi.fn().mockReturnValue(() => undefined),
  },
};

describe("App", () => {
  afterEach(cleanup);

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

  it("exports one mixed recording with the selected Markdown options", () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(
      <ExportPanel
        result={{ sessionId: "session-1", byteLength: 512 }}
        onExport={onExport}
        onDiscard={vi.fn().mockResolvedValue(undefined)}
        exporting={false}
        discarding={false}
        insightsAvailable
        transcriptAvailable
        savedOutput={null}
        error={null}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "音声ファイルを保存しますか？" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /日本語で会話を要約/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /日本語で Next Actions を作成/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /音声ファイルを保存/ }),
    );

    expect(onExport).toHaveBeenCalledWith({
      summary: true,
      nextActions: true,
    });
    expect(screen.queryByText("相手の音声")).toBeNull();
    expect(screen.queryByText("自分の音声")).toBeNull();
  });

  it("keeps MP3 export available when Luna is not configured", () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(
      <ExportPanel
        result={{ sessionId: "session-1", byteLength: 512 }}
        onExport={onExport}
        onDiscard={vi.fn().mockResolvedValue(undefined)}
        exporting={false}
        discarding={false}
        insightsAvailable={false}
        transcriptAvailable
        savedOutput={null}
        error={null}
      />,
    );

    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: /日本語で会話を要約/,
      }).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: /音声ファイルを保存/ }),
    );
    expect(onExport).toHaveBeenCalledWith({
      summary: false,
      nextActions: false,
    });
  });

  it("shows one bilingual conversation timeline and requires setup", async () => {
    render(<App />);

    expect(
      await screen.findByRole("region", { name: "会話タイムライン" }),
    ).toBeTruthy();
    expect(screen.getByText("SPEAKER OUTPUT")).toBeTruthy();
    expect(screen.getByText("MICROPHONE INPUT")).toBeTruthy();
    expect(screen.getByText("English → 日本語")).toBeTruthy();
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

  it("orders output left and input right in a shared timeline", () => {
    const transcripts = {
      speaker: [
        {
          id: "speaker-1",
          original: "How are you?",
          translation: "お元気ですか？",
          originalFinal: true,
          translationFinal: true,
          startedAt: "2026-09-04T08:00:02.000Z",
          elapsedMs: 1_000,
        },
      ],
      microphone: [
        {
          id: "microphone-1",
          original: "I am doing well.",
          translation: "元気です。",
          originalFinal: true,
          translationFinal: true,
          startedAt: "2026-09-04T08:00:01.000Z",
          elapsedMs: 2_000,
        },
      ],
    };
    expect(
      mergeTranscriptEntries(transcripts).map((entry) => entry.source),
    ).toEqual(["speaker", "microphone"]);

    render(
      <ConversationPane
        transcripts={transcripts}
        connections={{ speaker: "connected", microphone: "connected" }}
        levels={{ speaker: 0.25, microphone: 0.5 }}
        sourceErrors={{ speaker: null, microphone: null }}
      />,
    );

    const messages = screen.getAllByRole("article");
    expect(messages[0]?.classList.contains("conversation-message--speaker")).toBe(
      true,
    );
    expect(
      messages[1]?.classList.contains("conversation-message--microphone"),
    ).toBe(true);
    expect(screen.getByText("お元気ですか？")).toBeTruthy();
    expect(screen.getByText("元気です。")).toBeTruthy();
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

});

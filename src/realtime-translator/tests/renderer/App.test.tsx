import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/contracts";
import {
  App,
  ExportPanel,
  SessionControls,
  shouldShowConsentNotice,
  WindowControls,
} from "../../src/renderer/src/App";

const bridge: DesktopBridge = {
  application: {
    getInfo: vi.fn().mockResolvedValue({
      version: "0.1.13",
      lastUpdatedAt: "2026-09-05T00:45:00.000Z",
    }),
  },
  window: {
    getAppearance: vi.fn(),
    setTransparency: vi.fn(),
    setAlwaysOnTop: vi.fn(),
  },
  configuration: {
    get: vi.fn().mockResolvedValue(null),
    choose: vi.fn().mockResolvedValue(null),
  },
  authentication: {
    prepare: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
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
    vi.mocked(bridge.window.getAppearance).mockResolvedValue({
      transparencyPercent: 0,
      alwaysOnTop: false,
    });
    vi.mocked(bridge.window.setTransparency).mockImplementation(async (percent) => ({
      transparencyPercent: percent,
      alwaysOnTop: false,
    }));
    vi.mocked(bridge.window.setAlwaysOnTop).mockImplementation(async (alwaysOnTop) => ({
      transparencyPercent: 0,
      alwaysOnTop,
    }));
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

  it("shows separated bilingual panes and requires setup", async () => {
    render(<App />);

    expect(
      await screen.findByRole("region", { name: "SPEAKER OUTPUT" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "MICROPHONE INPUT" }),
    ).toBeTruthy();
    expect(screen.getAllByText("English → 日本語")).toHaveLength(2);
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

  it("changes native transparency immediately and can restore an opaque window", async () => {
    render(<WindowControls />);
    const slider = screen.getByRole("slider", { name: "透過率" });
    await waitFor(() => expect(slider).toBeEnabled());
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "80");

    fireEvent.change(slider, { target: { value: "55" } });
    expect(bridge.window.setTransparency).toHaveBeenCalledWith(55);
    await waitFor(() => expect(slider).toHaveValue("55"));
    fireEvent.click(screen.getByRole("button", { name: "不透明に戻す" }));
    await waitFor(() => expect(slider).toHaveValue("0"));
    expect(bridge.window.setTransparency).toHaveBeenLastCalledWith(0);
  });

  it("allows pinning and unpinning the native window", async () => {
    render(<WindowControls />);
    const button = screen.getByRole("button", { name: "最前面に固定" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(bridge.window.setAlwaysOnTop).toHaveBeenCalledWith(true);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(bridge.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it("keeps the newest slider value when older IPC replies arrive later", async () => {
    let finishOlder!: (value: { transparencyPercent: number; alwaysOnTop: boolean }) => void;
    vi.mocked(bridge.window.setTransparency).mockImplementationOnce(
      () => new Promise((resolve) => { finishOlder = resolve; }),
    );
    render(<WindowControls />);
    const slider = screen.getByRole("slider", { name: "透過率" });
    await waitFor(() => expect(slider).toBeEnabled());
    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.change(slider, { target: { value: "70" } });
    await waitFor(() => expect(slider).toHaveValue("70"));
    await act(async () => finishOlder({ transparencyPercent: 20, alwaysOnTop: false }));
    expect(slider).toHaveValue("70");
  });

  it("reports native window errors and restores the previous slider value", async () => {
    vi.mocked(bridge.window.setTransparency).mockRejectedValueOnce(new Error("window unavailable"));
    render(<WindowControls />);
    const slider = screen.getByRole("slider", { name: "透過率" });
    await waitFor(() => expect(slider).toBeEnabled());
    fireEvent.change(slider, { target: { value: "40" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("window unavailable");
    await waitFor(() => expect(slider).toHaveValue("0"));
  });

  it("reconciles with the native window after the newest of several changes fails", async () => {
    vi.mocked(bridge.window.getAppearance)
      .mockResolvedValueOnce({ transparencyPercent: 0, alwaysOnTop: false })
      .mockResolvedValueOnce({ transparencyPercent: 20, alwaysOnTop: true });
    vi.mocked(bridge.window.setTransparency)
      .mockResolvedValueOnce({ transparencyPercent: 20, alwaysOnTop: true })
      .mockRejectedValueOnce(new Error("latest change failed"));
    render(<WindowControls />);
    const slider = screen.getByRole("slider", { name: "透過率" });
    await waitFor(() => expect(slider).toBeEnabled());
    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.change(slider, { target: { value: "70" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("latest change failed");
    await waitFor(() => expect(slider).toHaveValue("20"));
    expect(screen.getByRole("button", { name: "最前面に固定" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("reports unavailable window settings without enabling misleading controls", async () => {
    vi.mocked(bridge.window.getAppearance).mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<WindowControls />);
    expect(await screen.findByRole("alert")).toHaveTextContent("IPC unavailable");
    expect(screen.getByRole("slider", { name: "透過率" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "最前面に固定" })).toBeDisabled();
  });

  it("shows the installed version and last update time in the footer", async () => {
    const { container } = render(<App />);

    expect(await screen.findByText("v0.1.13")).toBeTruthy();
    expect(screen.getByText("現在のバージョン")).toBeTruthy();
    expect(screen.getByText("最終更新日時")).toBeTruthy();
    const updatedAt = container.querySelector(
      'time[datetime="2026-09-05T00:45:00.000Z"]',
    );
    expect(updatedAt).toBeTruthy();
    expect(updatedAt?.textContent).toContain("2026");
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

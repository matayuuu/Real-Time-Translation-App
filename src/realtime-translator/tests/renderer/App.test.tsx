import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/contracts";
import { App, ExportPanel } from "../../src/renderer/src/App";

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
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /日本語で会話を要約/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /日本語で Next Actions を作成/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /会話音声を保存/ }),
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
      />,
    );

    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: /日本語で会話を要約/,
      }).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: /会話音声を保存/ }),
    );
    expect(onExport).toHaveBeenCalledWith({
      summary: false,
      nextActions: false,
    });
  });

  it("shows separated bilingual panes and requires setup", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "相手の発言" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "自分の発言" }),
    ).toBeTruthy();
    expect(screen.getByText("English → 日本語")).toBeTruthy();
    expect(screen.getByText("日本語 → English")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "会話を開始" })
        .disabled,
    ).toBe(true);
  });
});

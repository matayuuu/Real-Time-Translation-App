import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/contracts";
import { App } from "../../src/renderer/src/App";

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

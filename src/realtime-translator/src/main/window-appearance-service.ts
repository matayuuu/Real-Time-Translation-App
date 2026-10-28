import type { BrowserWindow } from "electron";

import {
  MAX_WINDOW_TRANSPARENCY_PERCENT,
  type WindowAppearance,
} from "../shared/contracts";

type AppearanceWindow = Pick<
  BrowserWindow,
  "getOpacity" | "setOpacity" | "isAlwaysOnTop" | "setAlwaysOnTop"
>;

export class WindowAppearanceService {
  public constructor(private readonly window: AppearanceWindow) {}

  public get(): WindowAppearance {
    return {
      transparencyPercent: Math.round((1 - this.window.getOpacity()) * 100),
      alwaysOnTop: this.window.isAlwaysOnTop(),
    };
  }

  public setTransparency(percent: unknown): WindowAppearance {
    if (
      typeof percent !== "number" ||
      !Number.isInteger(percent) ||
      percent < 0 ||
      percent > MAX_WINDOW_TRANSPARENCY_PERCENT
    ) {
      throw new Error(
        `透過率は 0～${MAX_WINDOW_TRANSPARENCY_PERCENT}% の整数で指定してください。`,
      );
    }

    this.window.setOpacity(1 - percent / 100);
    return this.get();
  }

  public setAlwaysOnTop(alwaysOnTop: unknown): WindowAppearance {
    if (typeof alwaysOnTop !== "boolean") {
      throw new Error("最前面への固定は true または false で指定してください。");
    }

    this.window.setAlwaysOnTop(alwaysOnTop);
    return this.get();
  }
}

// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WindowAppearanceService } from "../../src/main/window-appearance-service";

describe("WindowAppearanceService", () => {
  let opacity: number;
  let pinned: boolean;
  let service: WindowAppearanceService;
  const window = {
    getOpacity: vi.fn(() => opacity),
    setOpacity: vi.fn((value: number) => { opacity = value; }),
    isAlwaysOnTop: vi.fn(() => pinned),
    setAlwaysOnTop: vi.fn((value: boolean) => { pinned = value; }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    opacity = 1;
    pinned = false;
    service = new WindowAppearanceService(window);
  });

  it("reads the actual native window appearance", () => {
    opacity = 0.45;
    pinned = true;
    expect(service.get()).toEqual({ transparencyPercent: 55, alwaysOnTop: true });
  });

  it.each([0, 35, 80])("converts %i percent transparency into native opacity", (percent) => {
    expect(service.setTransparency(percent)).toEqual({
      transparencyPercent: percent,
      alwaysOnTop: false,
    });
    expect(window.setOpacity).toHaveBeenLastCalledWith(1 - percent / 100);
  });

  it.each([-1, 81, 100, 25.5, NaN, Infinity, "50", null, undefined])(
    "rejects invalid transparency %s without changing the native window",
    (percent) => {
      expect(() => service.setTransparency(percent)).toThrow("透過率");
      expect(window.setOpacity).not.toHaveBeenCalled();
      expect(opacity).toBe(1);
    },
  );

  it("pins and unpins without changing transparency", () => {
    service.setTransparency(50);
    expect(service.setAlwaysOnTop(true)).toEqual({
      transparencyPercent: 50,
      alwaysOnTop: true,
    });
    expect(service.setAlwaysOnTop(false).alwaysOnTop).toBe(false);
    expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
    expect(opacity).toBe(0.5);
  });

  it.each(["true", 1, null, undefined])("rejects invalid pin value %s", (value) => {
    expect(() => service.setAlwaysOnTop(value)).toThrow("最前面");
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("propagates native failures", () => {
    window.setOpacity.mockImplementationOnce(() => { throw new Error("native failure"); });
    expect(() => service.setTransparency(50)).toThrow("native failure");
  });
});

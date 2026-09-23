// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  visible: false,
  app: {
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: vi.fn(() => "C:\\translator-test"),
    getAppPath: vi.fn(() => "C:\\translator-test\\app"),
    getVersion: vi.fn(() => "0.1.20"),
    setAppUserModelId: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn<() => Promise<void>>(),
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: true,
  },
  window: {
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
    once: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn<(url: string) => Promise<void>>(),
    webContents: {
      on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      stop: vi.fn(),
    },
  },
  protocolHandle: vi.fn(),
  contextInitialize: vi.fn<() => Promise<null>>(),
  recordingInitialize: vi.fn<() => Promise<void>>(),
  updateStart: vi.fn(),
  showErrorBox: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: vi.fn(function (options: { show?: boolean }) {
    mocks.visible = options.show !== false;
    return mocks.window;
  }),
  desktopCapturer: {},
  dialog: { showErrorBox: mocks.showErrorBox },
  ipcMain: { handle: vi.fn() },
  net: {},
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: mocks.protocolHandle,
  },
  session: {
    defaultSession: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
    },
  },
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  mkdirSync: mocks.mkdirSync,
  writeFileSync: mocks.writeFileSync,
}));

vi.mock("../../src/main/context-service", () => ({
  ContextService: class {
    public initialize = mocks.contextInitialize;
    public get = () => null;
  },
}));

vi.mock("../../src/main/recording-service", () => ({
  RecordingService: class {
    public initialize = mocks.recordingInitialize;
  },
}));

vi.mock("../../src/main/electron-update-client", () => ({
  ElectronUpdateClient: class {},
}));

vi.mock("../../src/main/update-service", () => ({
  UpdateService: class {
    public start = mocks.updateStart;
    public stop = vi.fn();
  },
}));

function emit(
  source: typeof mocks.app | typeof mocks.window | typeof mocks.window.webContents,
  event: string,
  ...args: unknown[]
): void {
  for (const [name, listener] of source.on.mock.calls) {
    if (name === event) {
      listener(...args);
    }
  }
}

async function launch(): Promise<void> {
  await import("../../src/main/index");
  await vi.advanceTimersByTimeAsync(0);
}

describe("application startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\translator-test\\resources",
      configurable: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.visible = false;
    mocks.app.isPackaged = true;
    mocks.app.getPath.mockReturnValue("C:\\translator-test");
    mocks.app.getAppPath.mockReturnValue("C:\\translator-test\\app");
    mocks.app.getVersion.mockReturnValue("0.1.20");
    mocks.app.requestSingleInstanceLock.mockReturnValue(true);
    mocks.app.whenReady.mockResolvedValue(undefined);
    mocks.contextInitialize.mockResolvedValue(null);
    mocks.recordingInitialize.mockResolvedValue(undefined);
    mocks.window.loadURL.mockResolvedValue(undefined);
    mocks.window.isDestroyed.mockReturnValue(false);
    mocks.window.isMinimized.mockReturnValue(false);
    mocks.window.show.mockImplementation(() => { mocks.visible = true; });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    Reflect.deleteProperty(process, "resourcesPath");
    vi.restoreAllMocks();
  });

  it("shows the native window even when the first paint and page load never arrive", async () => {
    mocks.window.loadURL.mockImplementation(() => new Promise(() => {}));
    await launch();

    expect(mocks.window.loadURL).toHaveBeenCalledWith("app://local/index.html");
    expect(mocks.visible).toBe(true);
    expect(mocks.updateStart).not.toHaveBeenCalled();
  });

  it("does not depend on ready-to-show after the page has loaded", async () => {
    await launch();

    expect(mocks.visible).toBe(true);
    expect(mocks.updateStart).toHaveBeenCalledOnce();
  });

  it("explicitly shows a hidden window when the shortcut is opened again", async () => {
    await launch();
    mocks.visible = false;
    mocks.window.show.mockClear();
    emit(mocks.app, "second-instance");

    expect(mocks.visible).toBe(true);
    expect(mocks.window.show).toHaveBeenCalledOnce();
    expect(mocks.window.focus).toHaveBeenCalledOnce();
  });

  it("restores a minimized window before showing and focusing it", async () => {
    await launch();
    mocks.window.isMinimized.mockReturnValue(true);
    mocks.window.show.mockClear();
    emit(mocks.app, "second-instance");

    expect(mocks.window.restore).toHaveBeenCalledOnce();
    expect(mocks.window.show).toHaveBeenCalledOnce();
    expect(mocks.window.restore.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.window.show.mock.invocationCallOrder[0]!);
  });

  it("does not operate on a destroyed window during a second launch", async () => {
    await launch();
    mocks.window.isDestroyed.mockReturnValue(true);
    mocks.window.show.mockClear();
    emit(mocks.app, "second-instance");

    expect(mocks.window.show).not.toHaveBeenCalled();
    expect(mocks.window.focus).not.toHaveBeenCalled();
  });

  it("does not initialize another copy when the single-instance lock is held", async () => {
    mocks.app.requestSingleInstanceLock.mockReturnValue(false);
    await launch();

    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(mocks.app.whenReady).not.toHaveBeenCalled();
    expect(mocks.recordingInitialize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["electron-ready", () => mocks.app.whenReady.mockRejectedValueOnce(new Error("Ready failed"))],
    ["local-services", () => mocks.app.setAppUserModelId.mockImplementationOnce(() => {
      throw new Error("Service initialization failed");
    })],
    ["recordings", () => mocks.recordingInitialize.mockRejectedValueOnce(new Error("Access denied"))],
    ["app-protocol", () => mocks.protocolHandle.mockRejectedValueOnce(new Error("Protocol failed"))],
    ["renderer", () => mocks.window.loadURL.mockRejectedValueOnce(new Error("ERR_FILE_NOT_FOUND"))],
  ] as const)("reports a failure in %s and exits instead of holding the instance lock", async (stage, fail) => {
    fail();
    await launch();

    expect(mocks.showErrorBox).toHaveBeenCalledOnce();
    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      "Realtime Translator を起動できませんでした",
      expect.stringContaining(`処理: ${stage}`),
    );
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      "C:\\translator-test\\logs\\startup-error.log",
      expect.stringContaining(`Startup stage: ${stage}`),
      "utf8",
    );
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.updateStart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits a stuck renderer to 30 seconds and reports only one failure", async () => {
    let rejectLoad!: (error: Error) => void;
    mocks.window.loadURL.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectLoad = reject;
    }));
    await launch();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.showErrorBox).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("30 seconds"),
    );
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);

    rejectLoad(new Error("Late navigation failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.showErrorBox).toHaveBeenCalledOnce();
    expect(mocks.updateStart).not.toHaveBeenCalled();
  });

  it("does not continue initialization if a stalled configuration read finishes after timeout", async () => {
    let resolveContext!: (value: null) => void;
    mocks.contextInitialize.mockImplementation(() => new Promise((resolve) => {
      resolveContext = resolve;
    }));
    await launch();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("処理: configuration"),
    );
    resolveContext(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.recordingInitialize).not.toHaveBeenCalled();
    expect(mocks.window.loadURL).not.toHaveBeenCalled();
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  it("does not start updates if page loading completes after timeout", async () => {
    let resolveLoad!: () => void;
    mocks.window.loadURL.mockImplementation(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));
    await launch();
    await vi.advanceTimersByTimeAsync(30_000);
    resolveLoad();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.updateStart).not.toHaveBeenCalled();
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("also bounds the wait for Electron readiness", async () => {
    mocks.app.whenReady.mockImplementation(() => new Promise(() => {}));
    await launch();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("処理: electron-ready"),
    );
    expect(mocks.contextInitialize).not.toHaveBeenCalled();
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("immediately reports a renderer crash during startup", async () => {
    mocks.window.loadURL.mockImplementation(() => new Promise(() => {}));
    await launch();
    emit(mocks.window.webContents, "render-process-gone", {}, {
      reason: "crashed",
      exitCode: 123,
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("crashed (exit code 123)"),
    );
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.updateStart).not.toHaveBeenCalled();
  });

  it("clears the startup deadline after success without force-exiting an active session", async () => {
    await launch();
    await vi.advanceTimersByTimeAsync(60_000);
    emit(mocks.window.webContents, "render-process-gone", {}, {
      reason: "crashed",
      exitCode: 123,
    });

    expect(mocks.showErrorBox).not.toHaveBeenCalled();
    expect(mocks.app.exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats closing a loading window as cancellation rather than a startup error", async () => {
    let rejectLoad!: (error: Error) => void;
    mocks.window.loadURL.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectLoad = reject;
    }));
    await launch();
    emit(mocks.window, "closed");
    emit(mocks.app, "window-all-closed");
    rejectLoad(new Error("ERR_ABORTED"));
    emit(mocks.app, "second-instance");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(mocks.window.focus).not.toHaveBeenCalled();
    expect(mocks.showErrorBox).not.toHaveBeenCalled();
    expect(mocks.updateStart).not.toHaveBeenCalled();
  });

  it("cancels the deadline when quitting before a window exists", async () => {
    mocks.app.whenReady.mockImplementation(() => new Promise(() => {}));
    await launch();
    emit(mocks.app, "before-quit");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.showErrorBox).not.toHaveBeenCalled();
    expect(mocks.app.exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still shows the startup error if the diagnostic log cannot be saved", async () => {
    mocks.window.loadURL.mockRejectedValueOnce(new Error("Load failed"));
    mocks.writeFileSync.mockImplementationOnce(() => { throw new Error("Disk full"); });
    await launch();

    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("診断ログを保存できませんでした"),
    );
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(console.error).toHaveBeenCalledWith(
      "Could not save the startup diagnostic log.",
      expect.objectContaining({ message: "Disk full" }),
    );
  });

  it("keeps invalid configuration recoverable through the existing application UI", async () => {
    mocks.contextInitialize.mockRejectedValueOnce(new Error("Invalid context"));
    await launch();

    expect(mocks.visible).toBe(true);
    expect(mocks.window.webContents.send).toHaveBeenCalledWith(
      "app:event",
      { type: "configuration-error", message: "Invalid context" },
    );
    expect(mocks.showErrorBox).not.toHaveBeenCalled();
    expect(mocks.app.exit).not.toHaveBeenCalled();
  });

  it("does not fail a successful startup if the updater cannot start", async () => {
    mocks.updateStart.mockImplementationOnce(() => { throw new Error("Updater unavailable"); });
    await launch();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.visible).toBe(true);
    expect(console.error).toHaveBeenCalledWith("Automatic update failed: Updater unavailable");
    expect(mocks.showErrorBox).not.toHaveBeenCalled();
    expect(mocks.app.exit).not.toHaveBeenCalled();
  });

  it("uses the development renderer URL without weakening window isolation", async () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    mocks.app.isPackaged = false;
    await launch();
    const { BrowserWindow } = await import("electron");

    expect(mocks.window.loadURL).toHaveBeenCalledWith("http://localhost:5173");
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: true,
      webPreferences: expect.objectContaining({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      }),
    }));
    expect(mocks.updateStart).not.toHaveBeenCalled();
  });
});

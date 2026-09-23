import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
} from "electron";

import type {
  ExportRecordingRequest,
  RecordingAppendPayload,
  TranslationSecretRequest,
} from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc";
import { ApplicationInfoService } from "./application-info-service";
import { AuthenticationService } from "./authentication-service";
import { AzureCliAuthenticationClient } from "./azure-cli-authentication-client";
import { ConversationInsightsService } from "./conversation-insights-service";
import { ContextService } from "./context-service";
import { ElectronUpdateClient } from "./electron-update-client";
import { RecordingExportService } from "./recording-export-service";
import { RecordingService } from "./recording-service";
import { StartupGuard } from "./startup-guard";
import { TranslationSecretService } from "./translation-secret-service";
import { UpdateService } from "./update-service";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

app.setName("Realtime Translator");
// Keep existing settings and pending recordings across the product rename.
app.setPath(
  "userData",
  join(app.getPath("appData"), "teams-realtime-translator"),
);

const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL);
const appRoot = app.getAppPath();
const repositoryContextPath = isDevelopment
  ? resolve(appRoot, "..", "..", ".realtime-translation", "context.json")
  : null;

let mainWindow: BrowserWindow | null = null;
let applicationInfoService: ApplicationInfoService;
let contextService: ContextService;
let recordingService: RecordingService;
let recordingExportService: RecordingExportService;
let updateService: UpdateService | null = null;
let authenticationService: AuthenticationService;
let translationSecretService: TranslationSecretService;
let conversationInsightsService: ConversationInsightsService;

function trustedSender(url: string): boolean {
  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    return url.startsWith(process.env.ELECTRON_RENDERER_URL);
  }
  return url === "app://local" || url.startsWith("app://local/");
}

function requireTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? "";
  if (!trustedSender(senderUrl)) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.applicationGetInfo, (event) => {
    requireTrustedSender(event);
    return applicationInfoService.get();
  });

  ipcMain.handle(IPC_CHANNELS.configurationGet, (event) => {
    requireTrustedSender(event);
    return contextService.get();
  });

  ipcMain.handle(IPC_CHANNELS.configurationChoose, async (event) => {
    requireTrustedSender(event);
    if (authenticationService.isBusy) {
      throw new Error("認証を完了またはキャンセルしてから設定を変更してください。");
    }
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: ".realtime-translation/context.json を選択",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || selection.filePaths.length !== 1) {
      return null;
    }
    const configuration = await contextService.select(selection.filePaths[0]!);
    mainWindow?.webContents.send(IPC_CHANNELS.appEvent, {
      type: "configuration-changed",
      configuration,
    });
    return configuration;
  });

  ipcMain.handle(IPC_CHANNELS.authenticationPrepare, async (event) => {
    requireTrustedSender(event);
    const configuration = contextService.get();
    if (!configuration) {
      throw new Error("Select a valid .realtime-translation/context.json first.");
    }
    await authenticationService.prepare(configuration.context);
  });
  ipcMain.handle(IPC_CHANNELS.authenticationSignIn, async (event) => {
    requireTrustedSender(event);
    const configuration = contextService.get();
    if (!configuration) {
      throw new Error("Select a valid .realtime-translation/context.json first.");
    }
    await authenticationService.signIn(configuration.context);
  });
  ipcMain.handle(IPC_CHANNELS.authenticationCancel, async (event) => {
    requireTrustedSender(event);
    await authenticationService.cancel();
  });

  ipcMain.handle(
    IPC_CHANNELS.translationCreateSecret,
    async (event, request: TranslationSecretRequest) => {
      requireTrustedSender(event);
      const configuration = contextService.get();
      if (!configuration) {
        throw new Error(
          "Select a valid .realtime-translation/context.json first.",
        );
      }
      if (
        !request ||
        !["speaker", "microphone"].includes(request.source) ||
        request.targetLanguage !== "ja"
      ) {
        throw new Error("Invalid translation session request.");
      }
      return translationSecretService.create(configuration.context, request);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.recordingStart,
    async (event, sampleRate: number) => {
      requireTrustedSender(event);
      return recordingService.start(sampleRate);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.recordingAppend,
    async (event, payload: RecordingAppendPayload) => {
      requireTrustedSender(event);
      await recordingService.append(payload);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.recordingStop,
    async (event, sessionId: string) => {
      requireTrustedSender(event);
      return recordingService.stop(sessionId);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.recordingExport,
    async (event, request: ExportRecordingRequest) => {
      requireTrustedSender(event);
      return recordingExportService.export(request);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.recordingDiscard,
    async (event, sessionId: string) => {
      requireTrustedSender(event);
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new Error("Invalid recording session ID.");
      }
      await recordingService.discard(sessionId);
    },
  );
}

async function registerAppProtocol(): Promise<void> {
  const rendererRoot = resolve(import.meta.dirname, "../renderer");
  await protocol.handle("app", (request) => {
    const requestUrl = new URL(request.url);
    const requestedPath =
      requestUrl.pathname === "/"
        ? "index.html"
        : decodeURIComponent(requestUrl.pathname.slice(1));
    const absolutePath = resolve(rendererRoot, requestedPath);
    if (
      absolutePath !== rendererRoot &&
      !absolutePath.startsWith(`${rendererRoot}\\`)
    ) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(absolutePath).toString());
  });
}

function configureMediaPermissions(): void {
  const electronSession = session.defaultSession;
  electronSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      trustedSender(requestingOrigin) &&
      ["media", "display-capture"].includes(permission),
  );
  electronSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const senderUrl = webContents.getURL();
      callback(
        trustedSender(senderUrl) &&
          ["media", "display-capture"].includes(permission),
      );
    },
  );
  electronSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const screen = sources[0];
    if (!screen) {
      callback({});
      return;
    }
    callback({ video: screen, audio: "loopback" });
  });
}

function initializeServices(): void {
  app.setAppUserModelId("com.matayuuu.realtimetranslator");
  applicationInfoService = new ApplicationInfoService(
    join(app.getPath("userData"), "application-info.json"),
    app.getVersion(),
  );
  contextService = new ContextService(
    join(app.getPath("userData"), "settings.json"),
    repositoryContextPath,
  );
  let browserSignIn = false;
  authenticationService = new AuthenticationService(
    new AzureCliAuthenticationClient(join(app.getPath("userData"), "azure-cli")),
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.appEvent, {
          type: "authentication-changed",
          status,
        });
        if (status.state === "ready" && browserSignIn) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
      browserSignIn = status.state === "signing-in";
    },
  );
  translationSecretService = new TranslationSecretService(authenticationService);
  conversationInsightsService = new ConversationInsightsService(authenticationService);
  recordingService = new RecordingService(
    join(app.getPath("userData"), "recordings"),
  );
  recordingExportService = new RecordingExportService(
    recordingService,
    conversationInsightsService,
    () => contextService.get()?.context ?? null,
  );
}

async function createWindow(onStartupFailure: (error: Error) => void): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 800,
    minHeight: 500,
    title: "Realtime Translator",
    show: true,
    icon: isDevelopment
      ? resolve(appRoot, "build", "icon.ico")
      : join(process.resourcesPath, "icon.ico"),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!trustedSender(url)) {
      event.preventDefault();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    onStartupFailure(new Error(
      `Renderer exited during startup: ${details.reason} (exit code ${details.exitCode}).`,
    ));
  });

  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadURL("app://local/index.html");
  }
}

async function promptToInstallUpdate(version: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: "Realtime Translator の更新",
    message: `バージョン ${version} をダウンロードしました。`,
    detail: "再起動して更新を適用しますか？",
    buttons: ["再起動して更新", "後で"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

function reportUpdateError(error: Error): void {
  console.error(`Automatic update failed: ${error.message}`);
}

function reportStartupFailure(stage: string, error: Error): void {
  const logDirectory = join(app.getPath("userData"), "logs");
  const logPath = join(logDirectory, "startup-error.log");
  const detail = [
    new Date().toISOString(),
    `Realtime Translator ${app.getVersion()}`,
    `Startup stage: ${stage}`,
    error.stack ?? error.message,
  ].join("\n");
  console.error(detail);

  try {
    let logMessage = `診断ログ: ${logPath}`;
    try {
      mkdirSync(logDirectory, { recursive: true });
      writeFileSync(logPath, `${detail}\n`, "utf8");
    } catch (logError) {
      console.error("Could not save the startup diagnostic log.", logError);
      logMessage = "診断ログを保存できませんでした。下のエラー内容を控えてください。";
    }
    dialog.showErrorBox(
      "Realtime Translator を起動できませんでした",
      `起動処理を中止します。アプリを開き直してください。\n\n` +
        `処理: ${stage}\n${error.message}\n\n${logMessage}`,
    );
  } finally {
    app.exit(1);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  if (isDevelopment) {
    console.error(
      "Realtime Translator がすでに起動しています。新しい開発版は起動していません。" +
        "未保存の録音を保存し、既存アプリを終了してから npm run dev を再実行してください。",
    );
  }
  app.quit();
} else {
  const startup = new StartupGuard(reportStartupFailure);
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  async function initializeApplication(): Promise<void> {
    await startup.run("electron-ready", () => app.whenReady());
    await startup.run("local-services", initializeServices);

    let initializationError: string | null = null;
    await startup.run("configuration", async () => {
      try {
        await contextService.initialize();
      } catch (error) {
        initializationError =
          error instanceof Error ? error.message : String(error);
      }
    });
    await startup.run("recordings", () => recordingService.initialize());
    await startup.run("app-protocol", () => registerAppProtocol());
    await startup.run("permissions-and-ipc", () => {
      configureMediaPermissions();
      registerIpcHandlers();
    });
    await startup.run("renderer", () => createWindow((error) => startup.fail(error)));
    startup.stop();
    if (app.isPackaged) {
      try {
        updateService = new UpdateService(
          new ElectronUpdateClient(),
          promptToInstallUpdate,
          reportUpdateError,
        );
        updateService.start();
      } catch (error) {
        reportUpdateError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (initializationError) {
      mainWindow?.webContents.send(IPC_CHANNELS.appEvent, {
        type: "configuration-error",
        message: initializationError,
      });
    }
  }
  void initializeApplication().catch((error: unknown) => startup.fail(error));

  let cancellingBeforeQuit = false;
  app.on("before-quit", (event) => {
    if (authenticationService?.isBusy) {
      event.preventDefault();
      if (!cancellingBeforeQuit) {
        cancellingBeforeQuit = true;
        void authenticationService.cancel().then(() => app.quit());
      }
    } else {
      startup.stop();
    }
  });

  app.on("window-all-closed", () => {
    startup.stop();
    updateService?.stop();
    app.quit();
  });
}

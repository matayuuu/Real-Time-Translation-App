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
import { ConversationInsightsService } from "./conversation-insights-service";
import { ContextService } from "./context-service";
import { RecordingExportService } from "./recording-export-service";
import { RecordingService } from "./recording-service";
import { TranslationSecretService } from "./translation-secret-service";

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

const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL);
const appRoot = app.getAppPath();
const repositoryContextPath = isDevelopment
  ? resolve(appRoot, "..", "..", ".realtime-translation", "context.json")
  : null;

let mainWindow: BrowserWindow | null = null;
let contextService: ContextService;
let recordingService: RecordingService;
let recordingExportService: RecordingExportService;
const translationSecretService = new TranslationSecretService();
const conversationInsightsService = new ConversationInsightsService();

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
  ipcMain.handle(IPC_CHANNELS.configurationGet, (event) => {
    requireTrustedSender(event);
    return contextService.get();
  });

  ipcMain.handle(IPC_CHANNELS.configurationChoose, async (event) => {
    requireTrustedSender(event);
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
        !["en", "ja"].includes(request.targetLanguage)
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

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    show: false,
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
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadURL("app://local/index.html");
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    contextService = new ContextService(
      join(app.getPath("userData"), "settings.json"),
      repositoryContextPath,
    );
    recordingService = new RecordingService(
      join(app.getPath("userData"), "recordings"),
    );
    recordingExportService = new RecordingExportService(
      recordingService,
      conversationInsightsService,
      () => contextService.get()?.context ?? null,
    );

    let initializationError: string | null = null;
    try {
      await contextService.initialize();
    } catch (error) {
      initializationError =
        error instanceof Error ? error.message : String(error);
    }
    await recordingService.initialize();
    await registerAppProtocol();
    configureMediaPermissions();
    registerIpcHandlers();
    await createWindow();
    if (initializationError) {
      mainWindow?.webContents.send(IPC_CHANNELS.appEvent, {
        type: "configuration-error",
        message: initializationError,
      });
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}

import { contextBridge, ipcRenderer } from "electron";

import type {
  AppEvent,
  DesktopBridge,
  ExportRecordingRequest,
  RecordingAppendPayload,
  TranslationSecretRequest,
} from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc";

const bridge: DesktopBridge = {
  configuration: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.configurationGet),
    choose: () => ipcRenderer.invoke(IPC_CHANNELS.configurationChoose),
  },
  translation: {
    createSecret: (request: TranslationSecretRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.translationCreateSecret, request),
  },
  recording: {
    start: (sampleRate: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordingStart, sampleRate),
    append: (payload: RecordingAppendPayload) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordingAppend, payload),
    stop: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordingStop, sessionId),
    export: (request: ExportRecordingRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordingExport, request),
    discard: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordingDiscard, sessionId),
  },
  events: {
    subscribe(listener: (event: AppEvent) => void): () => void {
      const wrapped = (_electronEvent: Electron.IpcRendererEvent, event: AppEvent) => {
        listener(event);
      };
      ipcRenderer.on(IPC_CHANNELS.appEvent, wrapped);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.appEvent, wrapped);
    },
  },
};

contextBridge.exposeInMainWorld("desktop", bridge);

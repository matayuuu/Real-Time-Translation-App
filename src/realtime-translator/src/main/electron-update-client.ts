import electronUpdater from "electron-updater";

import type { UpdateClient } from "./update-service";

const { autoUpdater } = electronUpdater;

export class ElectronUpdateClient implements UpdateClient {
  public configure(): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
  }

  public onDownloaded(listener: (version: string) => void): void {
    autoUpdater.on("update-downloaded", (event) => listener(event.version));
  }

  public onError(listener: (error: Error) => void): void {
    autoUpdater.on("error", listener);
  }

  public async check(): Promise<void> {
    await autoUpdater.checkForUpdates();
  }

  public install(): void {
    autoUpdater.quitAndInstall(false, true);
  }
}

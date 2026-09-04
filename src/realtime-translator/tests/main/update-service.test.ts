// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  UpdateService,
  type UpdateClient,
} from "../../src/main/update-service";

class FakeUpdateClient implements UpdateClient {
  public configured = false;
  public installed = false;
  public check = vi.fn().mockResolvedValue(undefined);
  private downloadedListener: ((version: string) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  public configure(): void {
    this.configured = true;
  }

  public onDownloaded(listener: (version: string) => void): void {
    this.downloadedListener = listener;
  }

  public onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  public install(): void {
    this.installed = true;
  }

  public emitDownloaded(version: string): void {
    this.downloadedListener?.(version);
  }

  public emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

describe("UpdateService", () => {
  it("checks on startup and installs a downloaded update after confirmation", async () => {
    const client = new FakeUpdateClient();
    const prompt = vi.fn().mockResolvedValue(true);
    const reportError = vi.fn();
    const service = new UpdateService(client, prompt, reportError, 60_000);

    service.start();
    await vi.waitFor(() => expect(client.check).toHaveBeenCalledOnce());
    client.emitDownloaded("0.1.9");
    await vi.waitFor(() => expect(client.installed).toBe(true));
    service.stop();

    expect(client.configured).toBe(true);
    expect(prompt).toHaveBeenCalledWith("0.1.9");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("leaves a downloaded update pending when restart is deferred", async () => {
    const client = new FakeUpdateClient();
    const service = new UpdateService(
      client,
      vi.fn().mockResolvedValue(false),
      vi.fn(),
      60_000,
    );

    service.start();
    client.emitDownloaded("0.1.9");
    await Promise.resolve();
    await Promise.resolve();
    service.stop();

    expect(client.installed).toBe(false);
  });

  it("reports update check and updater errors without crashing the app", async () => {
    const client = new FakeUpdateClient();
    const checkError = new Error("offline");
    client.check.mockRejectedValueOnce(checkError);
    const reportError = vi.fn();
    const service = new UpdateService(
      client,
      vi.fn().mockResolvedValue(false),
      reportError,
      60_000,
    );

    service.start();
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(checkError));
    const updaterError = new Error("invalid update");
    client.emitError(updaterError);
    service.stop();

    expect(reportError).toHaveBeenCalledWith(updaterError);
  });
});

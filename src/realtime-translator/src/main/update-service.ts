const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1_000;

export interface UpdateClient {
  configure(): void;
  onDownloaded(listener: (version: string) => void): void;
  onError(listener: (error: Error) => void): void;
  check(): Promise<void>;
  install(): void;
}

export class UpdateService {
  private started = false;
  private checking = false;
  private prompting = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly client: UpdateClient,
    private readonly promptToRestart: (version: string) => Promise<boolean>,
    private readonly reportError: (error: Error) => void,
    private readonly intervalMs = UPDATE_CHECK_INTERVAL_MS,
  ) {}

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.client.configure();
    this.client.onDownloaded((version) => {
      void this.handleDownloaded(version);
    });
    this.client.onError((error) => this.reportError(error));
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async check(): Promise<void> {
    if (this.checking) {
      return;
    }
    this.checking = true;
    try {
      await this.client.check();
    } catch (error) {
      this.reportError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      this.checking = false;
    }
  }

  private async handleDownloaded(version: string): Promise<void> {
    if (this.prompting) {
      return;
    }
    this.prompting = true;
    try {
      if (await this.promptToRestart(version)) {
        this.client.install();
      }
    } catch (error) {
      this.reportError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      this.prompting = false;
    }
  }
}

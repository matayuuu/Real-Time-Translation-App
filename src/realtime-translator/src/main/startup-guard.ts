const STARTUP_TIMEOUT_MS = 30_000;

export class StartupGuard {
  private stage = "electron-ready";
  private stopped = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly reportFailure: (stage: string, error: Error) => void,
  ) {
    this.timer = setTimeout(() => {
      this.fail(new Error(`Startup did not finish within ${STARTUP_TIMEOUT_MS / 1_000} seconds.`));
    }, STARTUP_TIMEOUT_MS);
  }

  public async run<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
    this.requireActive();
    this.stage = stage;
    const result = await operation();
    // A timeout or a user-initiated quit must not resume delayed initialization.
    this.requireActive();
    return result;
  }

  public stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  public fail(error: unknown): void {
    if (this.stopped) {
      return;
    }
    this.stop();
    this.reportFailure(
      this.stage,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private requireActive(): void {
    if (this.stopped) {
      throw new Error("Application startup has stopped.");
    }
  }
}

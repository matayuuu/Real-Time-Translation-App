import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ApplicationInfo } from "../shared/contracts";

interface PersistedApplicationInfo extends ApplicationInfo {
  schemaVersion: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parsePersistedInfo(
  input: unknown,
  path: string,
): PersistedApplicationInfo {
  if (
    !isRecord(input) ||
    input.schemaVersion !== 1 ||
    typeof input.version !== "string" ||
    input.version.trim() === "" ||
    typeof input.lastUpdatedAt !== "string" ||
    Number.isNaN(Date.parse(input.lastUpdatedAt))
  ) {
    throw new Error(`Saved application information is invalid: ${path}`);
  }

  return {
    schemaVersion: 1,
    version: input.version,
    lastUpdatedAt: input.lastUpdatedAt,
  };
}

export class ApplicationInfoService {
  private infoPromise: Promise<ApplicationInfo> | null = null;

  public constructor(
    private readonly storagePath: string,
    private readonly currentVersion: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (currentVersion.trim() === "") {
      throw new Error("Application version must be a non-empty string.");
    }
  }

  public get(): Promise<ApplicationInfo> {
    this.infoPromise ??= this.load();
    return this.infoPromise;
  }

  private async load(): Promise<ApplicationInfo> {
    const persisted = await this.read();
    if (persisted?.version === this.currentVersion) {
      return {
        version: persisted.version,
        lastUpdatedAt: persisted.lastUpdatedAt,
      };
    }

    const current: PersistedApplicationInfo = {
      schemaVersion: 1,
      version: this.currentVersion,
      lastUpdatedAt: this.now().toISOString(),
    };
    await this.write(current);
    return {
      version: current.version,
      lastUpdatedAt: current.lastUpdatedAt,
    };
  }

  private async read(): Promise<PersistedApplicationInfo | null> {
    let raw: string;
    try {
      raw = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw new Error(
        `Saved application information could not be read: ${this.storagePath}. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let input: unknown;
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(
        `Saved application information is not valid JSON: ${this.storagePath}`,
      );
    }
    return parsePersistedInfo(input, this.storagePath);
  }

  private async write(info: PersistedApplicationInfo): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(info, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.storagePath);
  }
}

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  AppConfiguration,
  ModelDeploymentContext,
  RealtimeTranslationContext,
} from "../shared/contracts";

interface PersistedSettings {
  contextPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`${context}.${key} must be a non-empty string.`);
  }
  return candidate;
}

function parseDeployment(
  value: unknown,
  context: string,
): ModelDeploymentContext {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  const capacity = value.capacity;
  if (
    typeof capacity !== "number" ||
    !Number.isInteger(capacity) ||
    capacity < 1
  ) {
    throw new Error(`${context}.capacity must be a positive integer.`);
  }

  return {
    deployment_name: requireString(value, "deployment_name", context),
    model_name: requireString(value, "model_name", context),
    model_version: requireString(value, "model_version", context),
    sku: requireString(value, "sku", context),
    capacity,
  };
}

export function parseRealtimeTranslationContext(
  input: unknown,
): RealtimeTranslationContext {
  if (!isRecord(input) || !isRecord(input.realtime_translation)) {
    throw new Error(
      "The selected file does not contain a realtime_translation object.",
    );
  }

  const value = input.realtime_translation;
  if (value.schema_version !== 1) {
    throw new Error("realtime_translation.schema_version must be 1.");
  }
  if (value.setup_status !== "complete") {
    throw new Error(
      "realtime_translation.setup_status must be complete. Run setup first.",
    );
  }

  const endpoint = requireString(
    value,
    "openai_endpoint",
    "realtime_translation",
  );
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error("realtime_translation.openai_endpoint must be a URL.");
  }
  if (
    endpointUrl.protocol !== "https:" ||
    !endpointUrl.hostname.endsWith(".openai.azure.com")
  ) {
    throw new Error(
      "realtime_translation.openai_endpoint must use an Azure OpenAI HTTPS host.",
    );
  }

  return {
    schema_version: 1,
    setup_status: "complete",
    generated_at: requireString(
      value,
      "generated_at",
      "realtime_translation",
    ),
    subscription_id: requireString(
      value,
      "subscription_id",
      "realtime_translation",
    ),
    resource_group_name: requireString(
      value,
      "resource_group_name",
      "realtime_translation",
    ),
    location: requireString(value, "location", "realtime_translation"),
    ai_services_account_name: requireString(
      value,
      "ai_services_account_name",
      "realtime_translation",
    ),
    openai_endpoint: endpointUrl.origin,
    foundry_project_name: requireString(
      value,
      "foundry_project_name",
      "realtime_translation",
    ),
    foundry_project_endpoint: requireString(
      value,
      "foundry_project_endpoint",
      "realtime_translation",
    ),
    translation: parseDeployment(
      value.translation,
      "realtime_translation.translation",
    ),
    transcription: parseDeployment(
      value.transcription,
      "realtime_translation.transcription",
    ),
    model_retirement_date: requireString(
      value,
      "model_retirement_date",
      "realtime_translation",
    ),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class ContextService {
  private current: AppConfiguration | null = null;

  public constructor(
    private readonly settingsPath: string,
    private readonly developmentContextPath: string | null,
  ) {}

  public async initialize(): Promise<AppConfiguration | null> {
    const explicitPath = process.env.REALTIME_TRANSLATOR_CONTEXT?.trim();
    if (explicitPath) {
      this.current = await this.load(explicitPath);
      return this.current;
    }

    const persistedPath = await this.readPersistedContextPath();
    const candidates = [persistedPath, this.developmentContextPath].filter(
      (value): value is string => Boolean(value),
    );

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        this.current = await this.load(candidate);
        return this.current;
      }
    }

    return null;
  }

  public get(): AppConfiguration | null {
    return this.current;
  }

  public async select(path: string): Promise<AppConfiguration> {
    const configuration = await this.load(path);
    await this.persistContextPath(configuration.contextPath);
    this.current = configuration;
    return configuration;
  }

  private async load(path: string): Promise<AppConfiguration> {
    const absolutePath = resolve(path);
    const raw = await readFile(absolutePath, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Context file is not valid JSON: ${absolutePath}`);
    }

    return {
      contextPath: absolutePath,
      context: parseRealtimeTranslationContext(json),
    };
  }

  private async readPersistedContextPath(): Promise<string | null> {
    if (!(await pathExists(this.settingsPath))) {
      return null;
    }

    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const settings = JSON.parse(raw) as unknown;
      if (
        isRecord(settings) &&
        typeof settings.contextPath === "string" &&
        settings.contextPath.trim() !== ""
      ) {
        return settings.contextPath;
      }
      return null;
    } catch (error) {
      throw new Error(
        `Saved settings could not be read: ${this.settingsPath}. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async persistContextPath(contextPath: string): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.${process.pid}.tmp`;
    const settings: PersistedSettings = { contextPath };
    await writeFile(
      temporaryPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.settingsPath);
  }
}

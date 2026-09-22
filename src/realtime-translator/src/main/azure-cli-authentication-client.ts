import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { requireAzureGuid } from "../shared/azure-identifiers";
import { AuthenticationError } from "./authentication-error";
import type {
  AuthenticationClient,
  AuthenticationTarget,
  AzureAccessToken,
} from "./authentication-service";
import { runAzureCli, type AzureCliRunner } from "./azure-cli-runner";

const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AzureCliAuthenticationClient implements AuthenticationClient {
  public constructor(
    private readonly stateDirectory: string,
    private readonly run: AzureCliRunner = runAzureCli,
  ) {}

  public async resolveTenant(subscriptionId: string, signal: AbortSignal): Promise<string> {
    const subscription = requireAzureGuid(subscriptionId, "subscription_id");
    const directory = join(this.stateDirectory, "tenants");
    const path = join(directory, `${subscription}.txt`);
    try {
      return requireAzureGuid(await readFile(path, "utf8"), "saved tenant_id");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    let tenant: string;
    try {
      tenant = requireAzureGuid(
        await this.run(
          ["account", "show", "--subscription", subscription, "--query", "tenantId", "--output", "tsv", "--only-show-errors"],
          { signal },
        ),
        "tenant_id",
      );
    } catch (error) {
      if (
        error instanceof AuthenticationError &&
        ["cancelled", "timeout", "cli-unavailable"].includes(error.code)
      ) {
        throw error;
      }
      throw new AuthenticationError(
        "configuration",
        "接続先テナントを特定できません。context.json の realtime_translation.tenant_id にリソースのテナント ID を設定するか、対象環境の setup を再実行してください。",
      );
    }
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, tenant, "utf8");
    await rename(temporaryPath, path);
    return tenant;
  }

  public async getToken(target: AuthenticationTarget, signal: AbortSignal): Promise<AzureAccessToken> {
    const subscription = requireAzureGuid(target.subscriptionId, "subscription_id");
    const tenant = requireAzureGuid(target.tenantId, "tenant_id");
    const configDirectory = await this.configDirectory(tenant);
    const raw = await this.run(
      [
        "account", "get-access-token",
        // Azure CLI does not allow --tenant and --subscription together here.
        "--subscription", subscription,
        "--scope", FOUNDRY_SCOPE,
        "--output", "json", "--only-show-errors",
      ],
      { configDirectory, signal },
    );
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new AuthenticationError("request-failed", "Azure CLI が有効なトークン応答を返しませんでした。");
    }
    if (
      !isRecord(payload) ||
      typeof payload.accessToken !== "string" ||
      payload.accessToken === "" ||
      typeof payload.expires_on !== "number" ||
      !Number.isFinite(payload.expires_on)
    ) {
      throw new AuthenticationError(
        "request-failed",
        "Azure CLI のトークン応答が不正です。Azure CLI 2.61 以降を使用してください。",
      );
    }
    if (
      typeof payload.tenant !== "string" ||
      payload.tenant.toLowerCase() !== tenant ||
      typeof payload.subscription !== "string" ||
      payload.subscription.toLowerCase() !== subscription
    ) {
      throw new AuthenticationError(
        "configuration",
        "認証先と context のテナントまたはサブスクリプションが一致しません。接続先の設定を確認してください。",
      );
    }
    return { token: payload.accessToken, expiresOnTimestamp: payload.expires_on * 1_000 };
  }

  public async login(target: AuthenticationTarget, signal: AbortSignal): Promise<void> {
    const tenant = requireAzureGuid(target.tenantId, "tenant_id");
    const configDirectory = await this.configDirectory(tenant);
    await this.run(
      [
        "login", "--tenant", tenant,
        "--scope", FOUNDRY_SCOPE,
        "--output", "none", "--only-show-errors",
      ],
      { configDirectory, signal, login: true },
    );
  }

  private async configDirectory(tenant: string): Promise<string> {
    const path = join(this.stateDirectory, "profiles", tenant);
    await mkdir(path, { recursive: true });
    return path;
  }
}

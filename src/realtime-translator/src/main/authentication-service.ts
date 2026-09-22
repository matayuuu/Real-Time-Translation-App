import { requireAzureGuid } from "../shared/azure-identifiers";
import type {
  AuthenticationStatus,
  RealtimeTranslationContext,
} from "../shared/contracts";
import { AuthenticationError } from "./authentication-error";

export interface AuthenticationTarget {
  subscriptionId: string;
  tenantId: string;
}

export interface AzureAccessToken {
  token: string;
  expiresOnTimestamp: number;
}

export interface AuthenticationClient {
  resolveTenant(subscriptionId: string, signal: AbortSignal): Promise<string>;
  getToken(target: AuthenticationTarget, signal: AbortSignal): Promise<AzureAccessToken>;
  login(target: AuthenticationTarget, signal: AbortSignal): Promise<void>;
}

export interface FoundryTokenProvider {
  getToken(context: RealtimeTranslationContext): Promise<{ token: string }>;
}

const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class AuthenticationService implements FoundryTokenProvider {
  private readonly tokens = new Map<string, AzureAccessToken>();
  private readonly pending = new Map<string, Promise<AzureAccessToken>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly blocked = new Map<string, Error>();

  public constructor(
    private readonly client: AuthenticationClient,
    private readonly onStatus: (status: AuthenticationStatus) => void,
  ) {}

  public get isBusy(): boolean {
    return this.pending.size > 0;
  }

  public async prepare(context: RealtimeTranslationContext): Promise<void> {
    this.blocked.delete(this.key(context));
    await this.getToken(context);
  }

  public async signIn(context: RealtimeTranslationContext): Promise<void> {
    await this.requestToken(context, true);
  }

  public getToken(context: RealtimeTranslationContext): Promise<AzureAccessToken> {
    return this.requestToken(context, false);
  }

  private requestToken(
    context: RealtimeTranslationContext,
    forceSignIn: boolean,
  ): Promise<AzureAccessToken> {
    const key = this.key(context);
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }
    if (forceSignIn) {
      this.tokens.delete(key);
      this.blocked.delete(key);
    }
    const blocked = this.blocked.get(key);
    if (blocked) {
      return Promise.reject(blocked);
    }
    const cached = this.tokens.get(key);
    if (cached && cached.expiresOnTimestamp > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      return Promise.resolve(cached);
    }

    const controller = new AbortController();
    const attempt = { interactive: false };
    this.controllers.set(key, controller);
    const operation = this.acquire(context, controller.signal, attempt, forceSignIn)
      .then((token) => {
        this.tokens.set(key, token);
        return token;
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.tokens.delete(key);
        // Reconnect retries must not reopen a cancelled or unsuccessful login.
        if (
          attempt.interactive ||
          (failure instanceof AuthenticationError &&
            ["cancelled", "configuration"].includes(failure.code))
        ) {
          this.blocked.set(key, failure);
        }
        this.onStatus({ state: "error", message: failure.message });
        throw failure;
      })
      .finally(() => {
        this.pending.delete(key);
        this.controllers.delete(key);
      });
    this.pending.set(key, operation);
    return operation;
  }

  public async cancel(): Promise<void> {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    await Promise.allSettled(this.pending.values());
  }

  private key(context: RealtimeTranslationContext): string {
    const subscription = requireAzureGuid(context.subscription_id, "subscription_id");
    const tenant = context.tenant_id === undefined
      ? ""
      : requireAzureGuid(context.tenant_id, "tenant_id");
    return `${subscription}:${tenant}`;
  }

  private async acquire(
    context: RealtimeTranslationContext,
    signal: AbortSignal,
    attempt: { interactive: boolean },
    forceSignIn: boolean,
  ): Promise<AzureAccessToken> {
    this.onStatus({ state: "checking", message: "Azure の認証を確認しています。" });
    const subscriptionId = requireAzureGuid(context.subscription_id, "subscription_id");
    const tenantId = requireAzureGuid(
      context.tenant_id ?? await this.client.resolveTenant(subscriptionId, signal),
      "tenant_id",
    );
    const target = { subscriptionId, tenantId };
    const signIn = async (): Promise<void> => {
      if (signal.aborted) {
        throw new AuthenticationError("cancelled", "認証をキャンセルしました。");
      }
      attempt.interactive = true;
      this.onStatus({
        state: "signing-in",
        tenantId,
        message: "ブラウザーで Microsoft にサインインしてください。完了すると処理を再試行します。",
      });
      await this.client.login(target, signal);
    };
    if (forceSignIn) {
      await signIn();
    }
    let token: AzureAccessToken;
    try {
      token = await this.client.getToken(target, signal);
    } catch (error) {
      if (
        forceSignIn ||
        !(error instanceof AuthenticationError) ||
        error.code !== "login-required"
      ) {
        throw error;
      }
      await signIn();
      token = await this.client.getToken(target, signal);
    }
    if (signal.aborted) {
      throw new AuthenticationError("cancelled", "認証をキャンセルしました。");
    }
    if (
      !token.token ||
      !Number.isFinite(token.expiresOnTimestamp) ||
      token.expiresOnTimestamp <= Date.now()
    ) {
      throw new AuthenticationError(
        "request-failed",
        "有効な Azure トークンを取得できませんでした。接続を再試行してください。",
      );
    }
    this.onStatus({ state: "ready", tenantId, message: "Azure の認証が完了しました。" });
    return token;
  }
}

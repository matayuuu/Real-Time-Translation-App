// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../../src/main/authentication-error";
import {
  AuthenticationService,
  type AuthenticationClient,
} from "../../src/main/authentication-service";
import { createContext } from "../fixtures/context";

function harness() {
  const token = { token: "test-token", expiresOnTimestamp: Date.now() + 3_600_000 };
  const client = {
    resolveTenant: vi.fn<AuthenticationClient["resolveTenant"]>()
      .mockResolvedValue("11111111-1111-1111-1111-111111111111"),
    getToken: vi.fn<AuthenticationClient["getToken"]>().mockResolvedValue(token),
    login: vi.fn<AuthenticationClient["login"]>().mockResolvedValue(undefined),
  };
  const onStatus = vi.fn();
  return { client, token, onStatus, service: new AuthenticationService(client, onStatus) };
}

describe("AuthenticationService", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the configured tenant and reuses a valid token without opening a browser", async () => {
    const { client, service, token } = harness();
    const context = createContext();

    await expect(service.getToken(context)).resolves.toEqual(token);
    await expect(service.getToken(context)).resolves.toEqual(token);

    expect(client.getToken).toHaveBeenCalledExactlyOnceWith(
      { subscriptionId: context.subscription_id, tenantId: context.tenant_id },
      expect.any(AbortSignal),
    );
    expect(client.resolveTenant).not.toHaveBeenCalled();
    expect(client.login).not.toHaveBeenCalled();
  });

  it("shares one browser login and one retry between concurrent translation and insights requests", async () => {
    const { client, service, token, onStatus } = harness();
    client.getToken.mockRejectedValueOnce(new AuthenticationError("login-required", "sign in"));
    let finishLogin!: () => void;
    client.login.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishLogin = resolve;
    }));
    const context = createContext();
    const pending = [service.getToken(context), service.getToken(context), service.getToken(context)];
    await vi.waitFor(() => expect(client.login).toHaveBeenCalledOnce());

    expect(service.isBusy).toBe(true);
    finishLogin();
    await expect(Promise.all(pending)).resolves.toEqual([token, token, token]);
    expect(client.getToken).toHaveBeenCalledTimes(2);
    expect(client.login).toHaveBeenCalledExactlyOnceWith(
      { subscriptionId: context.subscription_id, tenantId: context.tenant_id },
      expect.any(AbortSignal),
    );
    expect(onStatus.mock.calls.map(([status]) => status.state)).toEqual(["checking", "signing-in", "ready"]);
    expect(service.isBusy).toBe(false);
  });

  it("refreshes expiring tokens without forcing another login", async () => {
    vi.useFakeTimers();
    const { client, service } = harness();
    await service.getToken(createContext());
    vi.setSystemTime(Date.now() + 3_550_000);
    client.getToken.mockResolvedValue({ token: "refreshed", expiresOnTimestamp: Date.now() + 3_600_000 });

    await expect(service.getToken(createContext())).resolves.toMatchObject({ token: "refreshed" });
    expect(client.getToken).toHaveBeenCalledTimes(2);
    expect(client.login).not.toHaveBeenCalled();
  });

  it("does not reuse a token when the context changes tenants or subscriptions", async () => {
    const { client, service } = harness();
    await service.getToken(createContext());
    const next = createContext({
      tenant_id: "22222222-2222-2222-2222-222222222222",
      subscription_id: "33333333-3333-3333-3333-333333333333",
    });
    await service.getToken(next);
    expect(client.getToken).toHaveBeenLastCalledWith(
      { tenantId: next.tenant_id, subscriptionId: next.subscription_id },
      expect.any(AbortSignal),
    );
    expect(client.getToken).toHaveBeenCalledTimes(2);
  });

  it("resolves a legacy context by its subscription, never by the default account", async () => {
    const { client, service } = harness();
    const context = createContext();
    delete context.tenant_id;

    await service.prepare(context);
    expect(client.resolveTenant).toHaveBeenCalledExactlyOnceWith(context.subscription_id, expect.any(AbortSignal));
    expect(client.getToken).toHaveBeenCalledWith(
      { subscriptionId: context.subscription_id, tenantId: "11111111-1111-1111-1111-111111111111" },
      expect.any(AbortSignal),
    );
  });

  it.each(["configuration", "cli-unavailable", "request-failed", "timeout"] as const)(
    "does not open the browser for a %s failure",
    async (code) => {
      const { client, service } = harness();
      const failure = new AuthenticationError(code, "failure");
      client.getToken.mockRejectedValue(failure);

      await expect(service.getToken(createContext())).rejects.toBe(failure);
      expect(client.login).not.toHaveBeenCalled();
    },
  );

  it("cancels an in-flight sign-in and suppresses automatic retries until an explicit prepare", async () => {
    const { client, service, token } = harness();
    client.getToken.mockRejectedValueOnce(new AuthenticationError("login-required", "sign in"));
    client.login.mockImplementationOnce((_target, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new AuthenticationError("cancelled", "cancelled")), { once: true });
    }));
    const context = createContext();
    const first = service.getToken(context);
    const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(client.login).toHaveBeenCalledOnce());
    await service.cancel();
    await rejected;

    await expect(service.getToken(context)).rejects.toMatchObject({ code: "cancelled" });
    expect(client.login).toHaveBeenCalledOnce();
    expect(client.getToken).toHaveBeenCalledOnce();

    client.getToken
      .mockRejectedValueOnce(new AuthenticationError("login-required", "sign in"))
      .mockResolvedValue(token);
    await expect(service.prepare(context)).resolves.toBeUndefined();
    expect(client.login).toHaveBeenCalledTimes(2);
  });

  it("never loops when login succeeds but token acquisition still requires interaction", async () => {
    const { client, service } = harness();
    client.getToken.mockRejectedValue(new AuthenticationError("login-required", "still unavailable"));

    await expect(service.getToken(createContext())).rejects.toThrow("still unavailable");
    await expect(service.getToken(createContext())).rejects.toThrow("still unavailable");
    expect(client.login).toHaveBeenCalledOnce();
    expect(client.getToken).toHaveBeenCalledTimes(2);
  });

  it("allows transient silent acquisition errors to recover on a reconnect retry", async () => {
    const { client, service, token } = harness();
    client.getToken.mockRejectedValueOnce(new AuthenticationError("request-failed", "network unavailable"));
    await expect(service.getToken(createContext())).rejects.toThrow("network unavailable");
    await expect(service.getToken(createContext())).resolves.toEqual(token);
    expect(client.getToken).toHaveBeenCalledTimes(2);
    expect(client.login).not.toHaveBeenCalled();
  });

  it("rejects unsafe IDs before invoking the CLI", async () => {
    const { client, service } = harness();
    await expect(service.prepare(createContext({ tenant_id: "common & echo unsafe" })))
      .rejects.toThrow("tenant_id must be a GUID");
    expect(client.login).not.toHaveBeenCalled();
    expect(client.getToken).not.toHaveBeenCalled();
  });

  it("allows explicit sign-in after the cached account cannot access the configured subscription", async () => {
    const { client, service, token } = harness();
    const context = createContext();
    client.getToken.mockRejectedValueOnce(
      new AuthenticationError("request-failed", "Subscription not found"),
    );

    await expect(service.prepare(context)).rejects.toThrow("Subscription not found");
    expect(client.login).not.toHaveBeenCalled();
    await expect(service.signIn(context)).resolves.toBeUndefined();
    expect(client.login).toHaveBeenCalledExactlyOnceWith(
      { subscriptionId: context.subscription_id, tenantId: context.tenant_id },
      expect.any(AbortSignal),
    );
    await expect(service.getToken(context)).resolves.toEqual(token);
    expect(client.getToken).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cached token and shares concurrent explicit sign-in attempts", async () => {
    const { client, service } = harness();
    const context = createContext();
    await service.getToken(context);
    const replacement = { token: "other-account-token", expiresOnTimestamp: Date.now() + 3_600_000 };
    client.getToken.mockResolvedValue(replacement);

    await Promise.all([service.signIn(context), service.signIn(context)]);

    expect(client.login).toHaveBeenCalledOnce();
    await expect(service.getToken(context)).resolves.toEqual(replacement);
    expect(client.getToken).toHaveBeenCalledTimes(2);
  });

  it("does not reopen the browser when explicit sign-in fails to acquire a usable token", async () => {
    const { client, service } = harness();
    client.getToken.mockRejectedValue(new AuthenticationError("login-required", "MFA not satisfied"));

    await expect(service.signIn(createContext())).rejects.toThrow("MFA not satisfied");
    await expect(service.getToken(createContext())).rejects.toThrow("MFA not satisfied");
    expect(client.login).toHaveBeenCalledOnce();
    expect(client.getToken).toHaveBeenCalledOnce();
  });

  it.each([NaN, Infinity, 0])("rejects an invalid or expired token timestamp %s", async (expiresOnTimestamp) => {
    const { client, service } = harness();
    client.getToken.mockResolvedValue({ token: "invalid-expiry", expiresOnTimestamp });
    await expect(service.getToken(createContext())).rejects.toMatchObject({
      code: "request-failed",
    });
    expect(client.login).not.toHaveBeenCalled();
  });
});

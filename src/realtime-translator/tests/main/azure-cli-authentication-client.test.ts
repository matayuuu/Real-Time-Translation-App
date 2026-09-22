// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../../src/main/authentication-error";
import { AzureCliAuthenticationClient } from "../../src/main/azure-cli-authentication-client";
import type { AzureCliRunner } from "../../src/main/azure-cli-runner";

const target = {
  subscriptionId: "00000000-0000-0000-0000-000000000000",
  tenantId: "11111111-1111-1111-1111-111111111111",
};
const tokenResponse = {
  accessToken: "test-secret-not-for-logging",
  tenant: target.tenantId,
  subscription: target.subscriptionId,
  expires_on: 2_000_000_000,
};

describe("AzureCliAuthenticationClient", () => {
  let directory: string;
  const signal = new AbortController().signal;
  const run = vi.fn<AzureCliRunner>();
  let client: AzureCliAuthenticationClient;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "translator-auth-test-"));
    run.mockReset();
    client = new AzureCliAuthenticationClient(directory, run);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("logs in with a fixed tenant in an application-only CLI profile", async () => {
    run.mockResolvedValue("");
    await client.login(target, signal);

    expect(run).toHaveBeenCalledExactlyOnceWith(
      ["login", "--tenant", target.tenantId, "--scope", "https://ai.azure.com/.default", "--output", "none", "--only-show-errors"],
      { signal, login: true, configDirectory: join(directory, "profiles", target.tenantId) },
    );
  });

  it("pins token requests to the subscription and validates the returned tenant", async () => {
    run.mockResolvedValue(JSON.stringify(tokenResponse));
    await expect(client.getToken(target, signal)).resolves.toEqual({
      token: tokenResponse.accessToken,
      expiresOnTimestamp: 2_000_000_000_000,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      ["account", "get-access-token", "--subscription", target.subscriptionId, "--scope", "https://ai.azure.com/.default", "--output", "json", "--only-show-errors"],
      { signal, configDirectory: join(directory, "profiles", target.tenantId) },
    );
    expect(run.mock.calls[0]![0]).not.toContain("--tenant");
  });

  it.each(["tenant", "subscription"])("rejects a mismatched %s without leaking tokens", async (key) => {
    run.mockResolvedValue(JSON.stringify({ ...tokenResponse, [key]: "22222222-2222-2222-2222-222222222222" }));
    const result = client.getToken(target, signal);
    await expect(result).rejects.toMatchObject({ code: "configuration" });
    await expect(result).rejects.not.toThrow(tokenResponse.accessToken);
  });

  it.each(["not-json", "{}", JSON.stringify({ ...tokenResponse, expires_on: "invalid" })])(
    "rejects malformed token output",
    async (output) => {
      run.mockResolvedValue(output);
      await expect(client.getToken(target, signal)).rejects.toMatchObject({ code: "request-failed" });
    },
  );

  it("persists only the legacy subscription's tenant and reuses it after CLI logout or restart", async () => {
    run.mockResolvedValue(`${target.tenantId}\r\n`);
    await expect(client.resolveTenant(target.subscriptionId, signal)).resolves.toBe(target.tenantId);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      ["account", "show", "--subscription", target.subscriptionId, "--query", "tenantId", "--output", "tsv", "--only-show-errors"],
      { signal },
    );
    expect(await readFile(join(directory, "tenants", `${target.subscriptionId}.txt`), "utf8")).toBe(target.tenantId);
    run.mockRejectedValue(new Error("CLI logged out"));
    const restarted = new AzureCliAuthenticationClient(directory, run);
    await expect(restarted.resolveTenant(target.subscriptionId, signal)).resolves.toBe(target.tenantId);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not guess a tenant or launch login when a legacy context cannot be resolved", async () => {
    run.mockRejectedValue(new AuthenticationError("login-required", "Please run az login"));
    await expect(client.resolveTenant(target.subscriptionId, signal))
      .rejects.toMatchObject({ code: "configuration", message: expect.stringContaining("tenant_id") });
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects shell injection before resolving profile paths or running commands", async () => {
    await expect(client.login({ ...target, tenantId: "../other & echo unsafe" }, signal))
      .rejects.toThrow("must be a GUID");
    await expect(client.getToken({ ...target, subscriptionId: "test%PATH%" }, signal))
      .rejects.toThrow("must be a GUID");
    expect(run).not.toHaveBeenCalled();
  });
});

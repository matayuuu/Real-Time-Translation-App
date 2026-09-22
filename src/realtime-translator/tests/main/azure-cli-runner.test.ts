// @vitest-environment node

import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyAzureCliFailure, runAzureCli } from "../../src/main/azure-cli-runner";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

function processFixture(pid: number): ChildProcess {
  const child = new ChildProcess();
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough() });
  vi.spyOn(child, "kill").mockReturnValue(true);
  return child;
}

describe("Azure CLI failure classification", () => {
  it.each([
    "ERROR: Please run 'az login' to setup account.",
    "AADSTS700082: The refresh token has expired due to inactivity.",
    "AADSTS70043: Sign-in frequency expired.",
    "AADSTS50076: MFA required.",
    "Interactive authentication is needed. Please run az login --scope ...",
  ])("recognizes an interactive login requirement", (message) => {
    expect(classifyAzureCliFailure(message).code).toBe("login-required");
  });

  it.each([
    "AADSTS53003: Blocked by Conditional Access. Please run 'az login'.",
    "AADSTS50020: Account from another tenant. Please run 'az login'.",
    "AADSTS700016: Application not found.",
    "AADSTS700016: Application was not found in the directory. Please run 'az login'.",
    "HTTPSConnectionPool: certificate verify failed",
    "ERROR: The subscription does not exist.",
  ])("does not prompt for configuration, policy, and network errors", (message) => {
    expect(classifyAzureCliFailure(message).code).toBe("request-failed");
  });

  it("does not forward CLI output containing secrets into UI errors", () => {
    const error = classifyAzureCliFailure("failed token=sensitive-token");
    expect(error.message).not.toContain("sensitive-token");
  });

  it("distinguishes a missing CLI from a logged-out account", () => {
    expect(classifyAzureCliFailure("'az' is not recognized as a command").code).toBe("cli-unavailable");
  });
});

describe("runAzureCli", () => {
  let child: ChildProcess;
  let controller: AbortController;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(spawn).mockReset();
    child = processFixture(41234);
    controller = new AbortController();
    vi.mocked(spawn).mockReturnValue(child);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a browser and disables subscription prompts only in the child process", async () => {
    const originalDirectory = process.env.AZURE_CONFIG_DIR;
    const originalBroker = process.env.AZURE_CORE_ENABLE_BROKER_ON_WINDOWS;
    const result = runAzureCli(["login", "--tenant", "11111111-1111-1111-1111-111111111111"], {
      signal: controller.signal,
      login: true,
      configDirectory: "C:\\app\\auth profile",
    });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: expect.objectContaining({
        AZURE_CONFIG_DIR: "C:\\app\\auth profile",
        AZURE_CORE_ENABLE_BROKER_ON_WINDOWS: "false",
        AZURE_CORE_LOGIN_EXPERIENCE_V2: "off",
        AZURE_LOGGING_ENABLE_LOG_FILE: "no",
        AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
      }),
    }));
    expect(process.env.AZURE_CONFIG_DIR).toBe(originalDirectory);
    expect(process.env.AZURE_CORE_ENABLE_BROKER_ON_WINDOWS).toBe(originalBroker);
    child.emit("close", 0);
    await expect(result).resolves.toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  async function finishCancellation(): Promise<void> {
    if (process.platform === "win32") {
      const killer = processFixture(51234);
      vi.mocked(spawn).mockReturnValueOnce(killer);
      controller.abort();
      expect(spawn).toHaveBeenLastCalledWith(
        expect.stringMatching(/taskkill\.exe$/),
        ["/PID", "41234", "/T", "/F"],
        expect.objectContaining({ windowsHide: true }),
      );
      child.emit("close", 1);
      killer.emit("close", 0);
    } else {
      controller.abort();
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit("close", 1);
    }
  }

  it("cancels only its own process tree and removes timers", async () => {
    const result = runAzureCli(["login"], { signal: controller.signal, login: true });
    const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
    await finishCancellation();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a browser login after three minutes", async () => {
    const result = runAzureCli(["login"], { signal: controller.signal, login: true });
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    const killer = processFixture(51234);
    vi.mocked(spawn).mockReturnValueOnce(killer);
    await vi.advanceTimersByTimeAsync(180_000);
    child.emit("close", 1);
    if (process.platform === "win32") {
      killer.emit("close", 0);
    }
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a sanitized error rather than the failed token command's stdout", async () => {
    const result = runAzureCli(["account", "get-access-token"], { signal: controller.signal });
    child.stdout?.emit("data", Buffer.from("secret-token"));
    child.stderr?.emit("data", Buffer.from("AADSTS53003: Access denied. secret-token"));
    child.emit("close", 1);
    await expect(result).rejects.toMatchObject({ code: "request-failed" });
    await expect(result).rejects.not.toThrow("secret-token");
  });

  it("does not start a command when cancellation was already requested", async () => {
    controller.abort();
    await expect(runAzureCli(["login"], { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails explicitly and releases timers if the login process cannot be terminated", async () => {
    const result = runAzureCli(["login"], { signal: controller.signal, login: true });
    const rejected = expect(result).rejects.toMatchObject({
      code: "request-failed",
      message: expect.stringContaining("終了できませんでした"),
    });
    if (process.platform === "win32") {
      const killer = processFixture(51234);
      vi.mocked(spawn).mockReturnValueOnce(killer);
      controller.abort();
      killer.emit("error", new Error("process denied"));
    } else {
      vi.mocked(child.kill).mockReturnValueOnce(false);
      controller.abort();
    }
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", 1);
  });

  it("stops a hidden device-code fallback instead of waiting for inaccessible input", async () => {
    const result = runAzureCli(["login"], { signal: controller.signal, login: true });
    const rejected = expect(result).rejects.toMatchObject({
      code: "request-failed",
      message: expect.stringContaining("ブラウザーを開けませんでした"),
    });
    const killer = processFixture(51234);
    vi.mocked(spawn).mockReturnValueOnce(killer);
    child.stdout?.emit("data", Buffer.from("Use a web browser to open https://microsoft.com/devicelogin and enter the code TEST123"));
    child.emit("close", 1);
    if (process.platform === "win32") {
      killer.emit("close", 0);
    }
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles process-launch errors without retaining a command timeout", async () => {
    const result = runAzureCli(["login"], { signal: controller.signal, login: true });
    const rejected = expect(result).rejects.toMatchObject({ code: "cli-unavailable" });
    child.emit("error", new Error("ENOENT"));
    child.emit("close", -1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["value & whoami", "%PATH%", "arg\nother", "\"unsafe\"", "..\\file"])(
    "rejects unsafe shell argument %s",
    async (arg) => {
      await expect(runAzureCli(["login", "--tenant", arg], { signal: controller.signal }))
        .rejects.toThrow("Unsafe Azure CLI argument");
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});

import { spawn } from "node:child_process";
import { join } from "node:path";

import { AuthenticationError } from "./authentication-error";

export interface AzureCliOptions {
  configDirectory?: string;
  signal: AbortSignal;
  login?: boolean;
}

export type AzureCliRunner = (
  args: readonly string[],
  options: AzureCliOptions,
) => Promise<string>;

const MAX_OUTPUT_BYTES = 1_048_576;
const COMMAND_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 180_000;

export function classifyAzureCliFailure(stderr: string): AuthenticationError {
  if (
    /(?:['"]?az['"]? is not recognized|(?:^|\n)(?:.*:\s*)?az:\s*(?:command )?not found|spawn az ENOENT|Azure CLI could not be found)/i.test(stderr)
  ) {
    return new AuthenticationError(
      "cli-unavailable",
      "Azure CLI が見つかりません。Azure CLI をインストールしてアプリを再起動してください。",
    );
  }
  const aadCode = stderr.match(/\bAADSTS\d+\b/)?.[0];
  const needsLogin = aadCode
    ? /^AADSTS(?:50058|50076|50079|50173|70043|700082|700084)$/.test(aadCode)
    : /(?:please run ['"]?az login|interactive authentication is needed|interaction_required|login_required)/i.test(stderr);
  if (needsLogin) {
    return new AuthenticationError("login-required", "Microsoft へのサインインが必要です。");
  }
  return new AuthenticationError(
    "request-failed",
    `Azure CLI の認証処理に失敗しました${aadCode ? ` (${aadCode})` : ""}。ネットワーク、対象テナントのアカウントと組織のアクセス制限を確認してください。`,
  );
}

export const runAzureCli: AzureCliRunner = (args, options) => {
  // Windows invokes az.cmd through cmd.exe; no unvalidated shell arguments are allowed.
  if (args.some((arg) => !/^[a-zA-Z0-9_./:=-]+$/.test(arg))) {
    return Promise.reject(new Error("Unsafe Azure CLI argument."));
  }
  if (options.signal.aborted) {
    return Promise.reject(new AuthenticationError("cancelled", "認証をキャンセルしました。"));
  }
  const windows = process.platform === "win32";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const env = {
    ...process.env,
    ...(options.configDirectory ? { AZURE_CONFIG_DIR: options.configDirectory } : {}),
    AZURE_CORE_ENABLE_BROKER_ON_WINDOWS: "false",
    AZURE_CORE_LOGIN_EXPERIENCE_V2: "off",
    AZURE_CORE_COLLECT_TELEMETRY: "no",
    AZURE_LOGGING_ENABLE_LOG_FILE: "no",
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
    PYTHONIOENCODING: "utf-8",
  };
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      windows ? join(systemRoot, "System32", "cmd.exe") : "az",
      windows ? ["/d", "/s", "/c", `az ${args.join(" ")}`] : [...args],
      {
        cwd: windows ? systemRoot : "/",
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let stopped: AuthenticationError | null = null;
    let closed = false;
    let stopping: Promise<void> | null = null;

    const stop = (failure: AuthenticationError): void => {
      if (closed || stopped) {
        return;
      }
      stopped = failure;
      if (windows && child.pid !== undefined) {
        // Killing only cmd.exe leaves the Python login and callback listener running.
        stopping = new Promise<void>((done, fail) => {
          const killer = spawn(
            join(systemRoot, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore", timeout: 5_000 },
          );
          killer.once("error", fail);
          killer.once("close", (code) => {
            if (code === 0 || closed) {
              done();
            } else {
              fail(new Error("Azure CLI process could not be stopped."));
            }
          });
        });
        void stopping.catch(() => {
          cleanup();
          reject(new AuthenticationError(
            "request-failed",
            "Azure CLI の認証プロセスを終了できませんでした。アプリを終了して認証画面を閉じてください。",
          ));
        });
      } else {
        if (!child.kill()) {
          cleanup();
          reject(new AuthenticationError(
            "request-failed",
            "Azure CLI の認証プロセスを終了できませんでした。アプリを終了して認証画面を閉じてください。",
          ));
        }
      }
    };
    const abort = (): void =>
      stop(new AuthenticationError("cancelled", "認証をキャンセルしました。ブラウザーの認証タブは閉じて構いません。"));
    const timeout = setTimeout(
      () => stop(new AuthenticationError(
        "timeout",
        options.login
          ? "サインインが3分以内に完了しませんでした。ブラウザーの認証タブを閉じ、アプリから再試行してください。"
          : "Azure の認証確認がタイムアウトしました。ネットワークを確認して再試行してください。",
      )),
      options.login ? LOGIN_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
    );
    options.signal.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
    };
    const collect = (chunk: Buffer, isError: boolean): void => {
      if (stopped) {
        return;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop(new AuthenticationError("request-failed", "Azure CLI の応答が大きすぎるため認証を中止しました。"));
        return;
      }
      if (isError) {
        stderr += chunk.toString("utf8");
      } else {
        stdout += chunk.toString("utf8");
      }
      if (
        options.login &&
        /(?:use a web browser to open.*(?:devicelogin|deviceauth)|enter the code)/is.test(stderr + stdout)
      ) {
        stop(new AuthenticationError(
          "request-failed",
          "認証用ブラウザーを開けませんでした。Windows の既定ブラウザーを確認して再試行してください。",
        ));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
    child.once("error", () => {
      closed = true;
      cleanup();
      reject(new AuthenticationError("cli-unavailable", "Azure CLI を起動できませんでした。インストールと PATH を確認してアプリを再起動してください。"));
    });
    child.once("close", (code) => {
      closed = true;
      cleanup();
      void (async () => {
        if (stopping) {
          await stopping;
        }
        if (stopped) {
          throw stopped;
        }
        if (code !== 0) {
          throw classifyAzureCliFailure(stderr);
        }
        resolve(stdout);
      })().catch(reject);
    });
    if (options.signal.aborted) {
      abort();
    }
  });
};

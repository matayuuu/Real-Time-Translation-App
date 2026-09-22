import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEvent, DesktopBridge, TranslationSessionSecret } from "../../src/shared/contracts";
import type { TranslationSessionCallbacks } from "../../src/renderer/src/realtime/translation-session";
import { App, ExportPanel } from "../../src/renderer/src/App";
import { createContext } from "../fixtures/context";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  list: vi.fn(),
  pipelineStart: vi.fn(),
  pipelinePause: vi.fn(),
  pipelineResume: vi.fn(),
  pipelineStop: vi.fn(),
  recordingStart: vi.fn(),
  recordingStop: vi.fn(),
  sessionStart: vi.fn(),
  sessionPause: vi.fn(),
  sessionResume: vi.fn(),
  prepareResume: vi.fn(),
  sessionClose: vi.fn(),
}));

vi.mock("../../src/renderer/src/audio/audio-capture", () => ({
  captureAudio: mocks.capture,
  listMicrophones: mocks.list,
  AudioPipeline: class {
    start = mocks.pipelineStart;
    pause = mocks.pipelinePause;
    resume = mocks.pipelineResume;
    stop = mocks.pipelineStop;
  },
}));
vi.mock("../../src/renderer/src/recording/recording-controller", () => ({
  RecordingController: class {
    start = mocks.recordingStart;
    stop = mocks.recordingStop;
    encode = vi.fn();
  },
}));
vi.mock("../../src/renderer/src/realtime/translation-session", () => ({
  TranslationSession: class {
    constructor(
      private source: "speaker" | "microphone",
      _track: unknown,
      private callbacks: TranslationSessionCallbacks,
    ) {}
    async start(secret?: TranslationSessionSecret) {
      await mocks.sessionStart(secret);
      this.callbacks.onState("connected");
      this.callbacks.onTranscript({
        source: this.source,
        side: "input",
        kind: "done",
        text: `${this.source} original`,
        itemId: "utterance-1",
      });
    }
    pause = mocks.sessionPause;
    resume = mocks.sessionResume;
    prepareResume = mocks.prepareResume;
    close = mocks.sessionClose;
  },
}));

const context = createContext();
const secret = {
  value: "test-ephemeral",
  endpoint: context.openai_endpoint,
  expiresAt: 2_000_000_000,
};
let notify: (event: AppEvent) => void;
const bridge: DesktopBridge = {
  application: {
    getInfo: vi.fn().mockResolvedValue({ version: "test", lastUpdatedAt: "2026-09-17T00:00:00Z" }),
  },
  configuration: {
    get: vi.fn(),
    choose: vi.fn(),
  },
  authentication: {
    prepare: vi.fn(),
    signIn: vi.fn(),
    cancel: vi.fn(),
  },
  translation: { createSecret: vi.fn() },
  recording: {
    start: vi.fn(),
    stop: vi.fn(),
    append: vi.fn(),
    export: vi.fn(),
    discard: vi.fn(),
  },
  events: {
    subscribe: (listener) => {
      notify = listener;
      return () => undefined;
    },
  },
};

async function clickStart(): Promise<void> {
  render(<App />);
  fireEvent.click(screen.getByRole("checkbox", { name: "同意を確認しました" }));
  const button = screen.getByRole("button", { name: "START CONVERSATION" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe("browser authentication flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "desktop", { configurable: true, value: bridge });
    vi.mocked(bridge.configuration.get).mockResolvedValue({ contextPath: "context.json", context });
    vi.mocked(bridge.authentication.prepare).mockResolvedValue(undefined);
    vi.mocked(bridge.authentication.signIn).mockResolvedValue(undefined);
    vi.mocked(bridge.authentication.cancel).mockResolvedValue(undefined);
    vi.mocked(bridge.translation.createSecret).mockResolvedValue(secret);
    mocks.capture.mockResolvedValue({
      speakerTrack: { enabled: true },
      microphoneTrack: { enabled: true },
      stop: vi.fn(),
    });
    mocks.list.mockResolvedValue([]);
    mocks.pipelineStart.mockResolvedValue(48_000);
    mocks.pipelinePause.mockResolvedValue(undefined);
    mocks.pipelineResume.mockResolvedValue(undefined);
    mocks.pipelineStop.mockResolvedValue(undefined);
    mocks.recordingStart.mockResolvedValue(undefined);
    mocks.recordingStop.mockResolvedValue({ sessionId: "session-1", byteLength: 128 });
    mocks.sessionStart.mockResolvedValue(undefined);
    mocks.prepareResume.mockResolvedValue(undefined);
    mocks.sessionClose.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("completes authentication and both Foundry requests before capturing or recording audio", async () => {
    let authenticate!: () => void;
    vi.mocked(bridge.authentication.prepare).mockImplementationOnce(() => new Promise<void>((resolve) => {
      authenticate = resolve;
    }));
    await clickStart();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.recordingStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => authenticate());
    await screen.findByRole("button", { name: "STOP" });
    expect(bridge.authentication.prepare).toHaveBeenCalledOnce();
    expect(bridge.translation.createSecret).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.recordingStart).toHaveBeenCalledOnce();
    expect(vi.mocked(bridge.translation.createSecret).mock.invocationCallOrder[1])
      .toBeLessThan(mocks.capture.mock.invocationCallOrder[0]!);
    expect(mocks.sessionStart).toHaveBeenCalledTimes(2);
    expect(mocks.sessionStart).toHaveBeenCalledWith(secret);
  });

  it.each(["認証をキャンセルしました。", "接続先テナントを特定できません。"])(
    "does not capture audio or show SESSION COMPLETE when authentication fails",
    async (message) => {
      vi.mocked(bridge.authentication.prepare).mockRejectedValueOnce(new Error(message));
      await clickStart();
      await screen.findByText(message);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.recordingStart).not.toHaveBeenCalled();
      expect(bridge.translation.createSecret).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: "START CONVERSATION" })).toBeEnabled();
    },
  );

  it("does not record when Foundry rejects access after successful sign-in", async () => {
    vi.mocked(bridge.translation.createSecret).mockRejectedValueOnce(new Error("Foundry 403"));
    await clickStart();
    await screen.findByText("Foundry 403");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.recordingStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("presents the actionable authentication message without Electron's IPC wrapper", async () => {
    vi.mocked(bridge.authentication.prepare).mockRejectedValueOnce(new Error(
      "Error invoking remote method 'authentication:prepare': AuthenticationError: 認証をキャンセルしました。",
    ));
    await clickStart();
    await screen.findByText("認証をキャンセルしました。", { exact: true });
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it("offers cancellation while the browser sign-in is pending", async () => {
    let rejectLogin!: (error: Error) => void;
    vi.mocked(bridge.authentication.prepare).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectLogin = reject;
    }));
    vi.mocked(bridge.authentication.cancel).mockImplementationOnce(async () => {
      rejectLogin(new Error("認証をキャンセルしました。"));
      notify({ type: "authentication-changed", status: { state: "error", message: "認証をキャンセルしました。" } });
    });
    await clickStart();
    act(() => notify({
      type: "authentication-changed",
      status: { state: "signing-in", message: "ブラウザーでサインインしてください。", tenantId: context.tenant_id! },
    }));
    expect(screen.getByRole("status")).toHaveTextContent(context.tenant_id!);
    fireEvent.click(screen.getByRole("button", { name: "認証をキャンセル" }));
    await screen.findByText("認証をキャンセルしました。");
    expect(bridge.authentication.cancel).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pauses during reauthentication and resumes with the same recording and transcript", async () => {
    await clickStart();
    await screen.findByRole("button", { name: "STOP" });
    expect(screen.getByText("speaker original")).toBeTruthy();
    act(() => notify({
      type: "authentication-changed",
      status: { state: "signing-in", message: "サインインしてください。" },
    }));
    const resume = await screen.findByRole("button", { name: "RESUME" });
    expect(resume).toBeDisabled();
    expect(mocks.sessionPause).toHaveBeenCalledTimes(2);
    expect(mocks.pipelinePause).toHaveBeenCalledOnce();
    expect(mocks.recordingStop).not.toHaveBeenCalled();

    act(() => notify({
      type: "authentication-changed",
      status: { state: "ready", message: "認証完了" },
    }));
    fireEvent.click(resume);
    await screen.findByRole("button", { name: "STOP" });
    expect(mocks.prepareResume).toHaveBeenCalledTimes(2);
    expect(mocks.pipelineResume).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.recordingStart).toHaveBeenCalledOnce();
    expect(screen.getByText("speaker original")).toBeTruthy();
    expect(bridge.recording.discard).not.toHaveBeenCalled();
  });

  it("keeps pause available while a silent authentication check is pending", async () => {
    await clickStart();
    await screen.findByRole("button", { name: "STOP" });
    act(() => notify({
      type: "authentication-changed",
      status: { state: "checking", message: "認証確認中" },
    }));

    const pause = screen.getByRole("button", { name: "STOP" });
    expect(pause).toBeEnabled();
    fireEvent.click(pause);
    expect(await screen.findByRole("button", { name: "RESUME" })).toBeDisabled();
    expect(mocks.pipelinePause).toHaveBeenCalledOnce();
    expect(mocks.sessionPause).toHaveBeenCalledTimes(2);
    expect(mocks.recordingStop).not.toHaveBeenCalled();
  });

  it("allows an explicit account change after an authentication error without recording", async () => {
    render(<App />);
    await screen.findByText("gpt-realtime-translate · eastus2");
    act(() => notify({
      type: "authentication-changed",
      status: { state: "error", message: "Subscription not found" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "サインインし直す" }));
    await waitFor(() => expect(bridge.authentication.signIn).toHaveBeenCalledOnce());
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.recordingStart).not.toHaveBeenCalled();
  });

  it("keeps a session paused and its recording intact when resume authentication is cancelled", async () => {
    await clickStart();
    fireEvent.click(await screen.findByRole("button", { name: "STOP" }));
    await screen.findByRole("button", { name: "RESUME" });
    vi.mocked(bridge.authentication.prepare).mockRejectedValueOnce(new Error("cancelled"));
    fireEvent.click(screen.getByRole("button", { name: "RESUME" }));
    await screen.findByText(/再開できませんでした: cancelled/);

    expect(screen.getByRole("button", { name: "RESUME" })).toBeEnabled();
    expect(mocks.recordingStop).not.toHaveBeenCalled();
    expect(mocks.pipelineResume).not.toHaveBeenCalled();
    expect(screen.getByText("speaker original")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows sign-in cancellation inside the export dialog while Markdown generation is pending", () => {
    const cancel = vi.fn();
    render(
      <ExportPanel
        result={{ sessionId: "session-1", byteLength: 128 }}
        onExport={vi.fn()}
        onDiscard={vi.fn()}
        exporting
        discarding={false}
        insightsAvailable
        transcriptAvailable
        savedOutput={null}
        error={null}
        authenticationStatus={{ state: "signing-in", message: "サインインしてください。" }}
        onCancelAuthentication={cancel}
      />,
    );
    const cancelButton = screen.getByRole("button", { name: "認証をキャンセル" });
    expect(cancelButton.closest('[role="dialog"]')).toBeTruthy();
    fireEvent.click(cancelButton);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("closes translation sessions before cancelling authentication when ending a session", async () => {
    await clickStart();
    await screen.findByRole("button", { name: "STOP" });
    fireEvent.click(screen.getByRole("button", { name: "END SESSION" }));
    await screen.findByRole("dialog");

    expect(mocks.sessionClose).toHaveBeenCalledTimes(2);
    expect(mocks.sessionClose.mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(bridge.authentication.cancel).mock.invocationCallOrder[0]!);
    expect(mocks.recordingStop).toHaveBeenCalledOnce();
  });

  it("still stops recording if authentication cancellation fails", async () => {
    vi.mocked(bridge.authentication.cancel).mockRejectedValueOnce(new Error("IPC unavailable"));
    await clickStart();
    await screen.findByRole("button", { name: "STOP" });
    fireEvent.click(screen.getByRole("button", { name: "END SESSION" }));
    await screen.findByRole("dialog");

    expect(mocks.recordingStop).toHaveBeenCalledOnce();
    expect(mocks.pipelineStop).toHaveBeenCalledOnce();
    expect(screen.getAllByText("認証を中止できませんでした: IPC unavailable").length).toBeGreaterThan(0);
  });
});

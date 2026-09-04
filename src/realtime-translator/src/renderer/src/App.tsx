import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type {
  AppConfiguration,
  AudioSource,
  ConversationExportOptions,
  ConversationTranscriptEntry,
  RecordingStopResult,
} from "@shared/contracts";

import {
  AudioPipeline,
  captureAudio,
  listMicrophones,
  type CapturedAudio,
} from "./audio/audio-capture";
import { RecordingController } from "./recording/recording-controller";
import {
  TranslationSession,
  type TranslationConnectionState,
} from "./realtime/translation-session";
import {
  EMPTY_TRANSCRIPTS,
  transcriptReducer,
  type TranscriptEntry,
  type TranscriptState,
} from "./transcript/reducer";

export type AppPhase =
  | "idle"
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "stopping"
  | "finished"
  | "error";

const MAX_VISIBLE_TRANSCRIPT_ENTRIES = 200;

export function shouldShowConsentNotice(phase: AppPhase): boolean {
  return phase === "idle" || phase === "error";
}

const INITIAL_CONNECTIONS: Record<
  AudioSource,
  TranslationConnectionState
> = {
  speaker: "idle",
  microphone: "idle",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function connectionLabel(state: TranslationConnectionState): string {
  const labels: Record<TranslationConnectionState, string> = {
    idle: "未接続",
    connecting: "接続中",
    connected: "接続済み",
    reconnecting: "再接続中",
    closing: "終了処理中",
    closed: "終了",
    error: "エラー",
  };
  return labels[state];
}

interface LevelMeterProps {
  label: string;
  value: number;
  compact?: boolean;
}

function LevelMeter({
  label,
  value,
  compact = false,
}: LevelMeterProps): React.JSX.Element {
  return (
    <div
      className={compact ? "level level--compact" : "level"}
      aria-label={`${label} 音量 ${Math.round(value * 100)}%`}
    >
      <span>{label}</span>
      <progress
        className="level__track"
        max={1}
        value={Math.max(0.015, value)}
      />
    </div>
  );
}

interface SessionControlsProps {
  phase: AppPhase;
  canStart: boolean;
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
}

export function SessionControls({
  phase,
  canStart,
  onStart,
  onPause,
  onResume,
  onStop,
}: SessionControlsProps): React.JSX.Element {
  if (phase === "running") {
    return (
      <div className="primary-actions">
        <button
          className="button button--pause"
          type="button"
          onClick={onPause}
        >
          STOP
        </button>
        <button
          className="button button--stop"
          type="button"
          onClick={onStop}
        >
          END SESSION
        </button>
      </div>
    );
  }

  if (phase === "paused") {
    return (
      <div className="primary-actions">
        <button
          className="button button--primary"
          type="button"
          onClick={onResume}
        >
          RESUME
        </button>
        <button
          className="button button--stop"
          type="button"
          onClick={onStop}
        >
          END SESSION
        </button>
      </div>
    );
  }

  const transitionLabels: Partial<Record<AppPhase, string>> = {
    starting: "CONNECTING...",
    pausing: "PAUSING...",
    resuming: "RESUMING...",
    stopping: "FINISHING...",
  };

  return (
    <div className="primary-actions">
      <button
        className="button button--primary"
        type="button"
        disabled={!canStart}
        onClick={onStart}
      >
        {transitionLabels[phase] ?? "START CONVERSATION"}
      </button>
    </div>
  );
}

interface ConversationMessage extends TranscriptEntry {
  source: AudioSource;
}

export function mergeTranscriptEntries(
  transcripts: TranscriptState,
): ConversationMessage[] {
  return [
    ...transcripts.speaker.map((entry) => ({
      ...entry,
      source: "speaker" as const,
    })),
    ...transcripts.microphone.map((entry) => ({
      ...entry,
      source: "microphone" as const,
    })),
  ].sort((left, right) => {
    if (
      left.elapsedMs !== undefined &&
      right.elapsedMs !== undefined &&
      left.elapsedMs !== right.elapsedMs
    ) {
      return left.elapsedMs - right.elapsedMs;
    }
    const timestampDifference =
      Date.parse(left.startedAt) - Date.parse(right.startedAt);
    if (timestampDifference !== 0) {
      return timestampDifference;
    }
    return left.source === "speaker" ? -1 : 1;
  });
}

interface SourceIndicatorProps {
  source: AudioSource;
  connection: TranslationConnectionState;
  level: number;
}

function SourceIndicator({
  source,
  connection,
  level,
}: SourceIndicatorProps): React.JSX.Element {
  const isSpeaker = source === "speaker";
  const label = isSpeaker ? "SPEAKER OUTPUT" : "MICROPHONE INPUT";
  return (
    <div
      className={`conversation-source conversation-source--${source}`}
      aria-label={`${label}: ${connectionLabel(connection)}`}
    >
      <div className="conversation-source__title">
        <span className="conversation-source__swatch" aria-hidden="true" />
        <strong>{label}</strong>
        <span className={`status status--${connection}`}>
          {connectionLabel(connection)}
        </span>
      </div>
      <LevelMeter
        label={isSpeaker ? "スピーカー" : "マイク"}
        value={level}
        compact
      />
    </div>
  );
}

interface ConversationPaneProps {
  transcripts: TranscriptState;
  connections: Record<AudioSource, TranslationConnectionState>;
  levels: Record<AudioSource, number>;
  sourceErrors: Record<AudioSource, string | null>;
}

export function ConversationPane({
  transcripts,
  connections,
  levels,
  sourceErrors,
}: ConversationPaneProps): React.JSX.Element {
  const entries = useMemo(
    () => mergeTranscriptEntries(transcripts),
    [transcripts],
  );
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    if (typeof list.scrollTo === "function") {
      list.scrollTo({
        top: list.scrollHeight,
        behavior: "smooth",
      });
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }, [entries]);

  return (
    <section className="conversation-pane" aria-labelledby="conversation-title">
      <header className="conversation-pane__header">
        <div>
          <p className="eyebrow">LIVE CONVERSATION</p>
          <h2 id="conversation-title">会話タイムライン</h2>
          <p className="language-pair">English → 日本語</p>
        </div>
        <div className="conversation-sources">
          <SourceIndicator
            source="speaker"
            connection={connections.speaker}
            level={levels.speaker}
          />
          <SourceIndicator
            source="microphone"
            connection={connections.microphone}
            level={levels.microphone}
          />
        </div>
      </header>

      {sourceErrors.speaker || sourceErrors.microphone ? (
        <div className="conversation-errors">
          {sourceErrors.speaker ? (
            <div className="inline-error">
              SPEAKER OUTPUT: {sourceErrors.speaker}
            </div>
          ) : null}
          {sourceErrors.microphone ? (
            <div className="inline-error">
              MICROPHONE INPUT: {sourceErrors.microphone}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="conversation-list" ref={listRef}>
        {entries.length === 0 ? (
          <div className="empty-transcript">
            <span className="empty-transcript__mark">Aa</span>
            <p>
              相手の音声は左、自分のマイク音声は右に表示されます。
            </p>
          </div>
        ) : (
          entries
            .slice(-MAX_VISIBLE_TRANSCRIPT_ENTRIES * 2)
            .map((entry) => {
              const isSpeaker = entry.source === "speaker";
              return (
                <article
                  className={`conversation-message conversation-message--${entry.source}`}
                  aria-label={isSpeaker ? "SPEAKER OUTPUT" : "MICROPHONE INPUT"}
                  key={`${entry.source}-${entry.id}`}
                >
                  <div className="conversation-message__meta">
                    <strong>
                      {isSpeaker ? "SPEAKER OUTPUT" : "MICROPHONE INPUT"}
                    </strong>
                    <time>{formatTime(entry.startedAt)}</time>
                  </div>
                  <div className="conversation-bubble">
                    <div className="conversation-bubble__original">
                      <span>EN</span>
                      <p className={entry.originalFinal ? "" : "is-partial"}>
                        {entry.original || "…"}
                      </p>
                    </div>
                    <div className="conversation-bubble__translation">
                      <span>JA</span>
                      <p
                        className={
                          entry.translationFinal ? "" : "is-partial"
                        }
                      >
                        {entry.translation || "…"}
                      </p>
                    </div>
                  </div>
                </article>
              );
            })
        )}
      </div>
    </section>
  );
}

interface ExportPanelProps {
  result: RecordingStopResult;
  onExport(options: ConversationExportOptions): Promise<void>;
  onDiscard(): Promise<void>;
  exporting: boolean;
  discarding: boolean;
  insightsAvailable: boolean;
  transcriptAvailable: boolean;
  savedOutput: string | null;
  error: string | null;
}

export function ExportPanel({
  result,
  onExport,
  onDiscard,
  exporting,
  discarding,
  insightsAvailable,
  transcriptAvailable,
  savedOutput,
  error,
}: ExportPanelProps): React.JSX.Element {
  const [summary, setSummary] = useState(false);
  const [nextActions, setNextActions] = useState(false);
  const documentsAvailable = insightsAvailable && transcriptAvailable;
  const busy = exporting || discarding;

  useEffect(() => {
    if (!documentsAvailable) {
      setSummary(false);
      setNextActions(false);
    }
  }, [documentsAvailable]);

  const options: ConversationExportOptions = { summary, nextActions };
  const bundleRequested = summary || nextActions;

  return (
    <div className="export-backdrop">
      <section
        className="export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        aria-busy={busy}
      >
        <div className="export-panel__intro">
          <p className="eyebrow">SESSION COMPLETE</p>
          <h2 id="export-title">音声ファイルを保存しますか？</h2>
          <p>
            相手と自分をミックスした MP3 を保存します。必要な Markdown を追加で選択できます。
          </p>
        </div>
        <div className="export-controls">
          <fieldset className="export-options">
            <legend>Markdown オプション</legend>
            <label className="export-option">
              <input
                type="checkbox"
                checked={summary}
                disabled={busy || !documentsAvailable}
                onChange={(event) => setSummary(event.target.checked)}
              />
              <span>
                <strong>日本語で会話を要約</strong>
                <small>概要、主な論点、決定事項、未解決事項</small>
              </span>
            </label>
            <label className="export-option">
              <input
                type="checkbox"
                checked={nextActions}
                disabled={busy || !documentsAvailable}
                onChange={(event) => setNextActions(event.target.checked)}
              />
              <span>
                <strong>日本語で Next Actions を作成</strong>
                <small>明示された行動、担当者、期限を整理</small>
              </span>
            </label>
          </fieldset>
          {!insightsAvailable ? (
            <p className="export-hint">
              Markdown を生成するには setup を再実行し、gpt-5.6-luna を追加してください。
            </p>
          ) : !transcriptAvailable ? (
            <p className="export-hint">
              Markdown を生成できる会話ログがありません。MP3 は保存できます。
            </p>
          ) : (
            <p className="export-hint">
              選択時だけ会話ログを Luna へ送信します。音声は追加送信しません。
            </p>
          )}
          {error ? (
            <div className="global-message global-message--error">{error}</div>
          ) : null}
          <div className="export-actions">
            <button
              className="export-button"
              type="button"
              disabled={busy || result.byteLength === 0}
              onClick={() => void onExport(options)}
            >
              <span>{exporting ? "生成・保存中…" : "音声ファイルを保存"}</span>
              <small>
                {bundleRequested
                  ? "一意フォルダーに MP3 と Markdown を保存"
                  : "一意な名前で混合 MP3 を保存"}
              </small>
            </button>
            <button
              className="button button--discard"
              type="button"
              disabled={busy}
              onClick={() => void onDiscard()}
            >
              {discarding
                ? "CLOSING..."
                : savedOutput
                  ? "DONE"
                  : "DISCARD & CLOSE"}
            </button>
          </div>
          {savedOutput ? (
            <p className="export-success" role="status">
              保存しました: <span>{savedOutput}</span>
            </p>
          ) : (
            <p className="export-hint">
              保存せず閉じる場合、一時録音は端末から削除されます。
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [configuration, setConfiguration] =
    useState<AppConfiguration | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(
    null,
  );
  const [phase, setPhase] = useState<AppPhase>("idle");
  const [consent, setConsent] = useState(false);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState("");
  const [connections, setConnections] = useState(INITIAL_CONNECTIONS);
  const [levels, setLevels] = useState<Record<AudioSource, number>>({
    speaker: 0,
    microphone: 0,
  });
  const [sourceErrors, setSourceErrors] = useState<
    Record<AudioSource, string | null>
  >({ speaker: null, microphone: null });
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordingResult, setRecordingResult] =
    useState<RecordingStopResult | null>(null);
  const [exportingRecording, setExportingRecording] = useState(false);
  const [discardingRecording, setDiscardingRecording] = useState(false);
  const [savedOutput, setSavedOutput] = useState<string | null>(null);
  const [transcripts, dispatchTranscript] = useReducer(
    transcriptReducer,
    EMPTY_TRANSCRIPTS,
  );

  const capturedRef = useRef<CapturedAudio | null>(null);
  const pipelineRef = useRef<AudioPipeline | null>(null);
  const recorderRef = useRef<RecordingController | null>(null);
  const sessionsRef = useRef<
    Partial<Record<AudioSource, TranslationSession>>
  >({});
  const startedAtRef = useRef<number | null>(null);
  const accumulatedElapsedMsRef = useRef(0);

  const refreshMicrophones = useCallback(async (): Promise<void> => {
    try {
      const devices = await listMicrophones();
      setMicrophones(devices);
      setMicrophoneDeviceId((current) => {
        if (
          current &&
          devices.some((device) => device.deviceId === current)
        ) {
          return current;
        }
        return devices[0]?.deviceId ?? "";
      });
    } catch (error) {
      setGlobalError(`マイク一覧を取得できません: ${errorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    void window.desktop.configuration
      .get()
      .then(setConfiguration)
      .catch((error: unknown) => setConfigurationError(errorMessage(error)));
    void refreshMicrophones();
    return window.desktop.events.subscribe((event) => {
      if (event.type === "configuration-changed") {
        setConfiguration(event.configuration);
        setConfigurationError(null);
      } else {
        setConfigurationError(event.message);
      }
    });
  }, [refreshMicrophones]);

  useEffect(() => {
    if (phase !== "running" || startedAtRef.current === null) {
      return;
    }
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) {
        return;
      }
      setElapsedSeconds(
        Math.floor(
          (accumulatedElapsedMsRef.current + Date.now() - startedAt) / 1_000,
        ),
      );
    }, 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  const chooseConfiguration = async (): Promise<void> => {
    try {
      const selected = await window.desktop.configuration.choose();
      if (selected) {
        setConfiguration(selected);
        setConfigurationError(null);
      }
    } catch (error) {
      setConfigurationError(errorMessage(error));
    }
  };

  const stopResources = useCallback(async (): Promise<RecordingStopResult | null> => {
    const failures: string[] = [];
    const sessionResults = await Promise.allSettled(
      Object.values(sessionsRef.current).map((session) => session.close()),
    );
    for (const result of sessionResults) {
      if (result.status === "rejected") {
        failures.push(errorMessage(result.reason));
      }
    }
    sessionsRef.current = {};

    if (pipelineRef.current) {
      try {
        await pipelineRef.current.stop();
      } catch (error) {
        failures.push(errorMessage(error));
      }
      pipelineRef.current = null;
    }
    capturedRef.current?.stop();
    capturedRef.current = null;

    let result: RecordingStopResult | null = null;
    if (recorderRef.current) {
      try {
        result = await recorderRef.current.stop();
      } catch (error) {
        failures.push(errorMessage(error));
      }
      recorderRef.current = null;
    }
    setLevels({ speaker: 0, microphone: 0 });
    if (failures.length > 0) {
      setGlobalError(failures.join(" / "));
    }
    return result;
  }, []);

  const start = async (): Promise<void> => {
    if (!configuration || !consent || phase === "running") {
      return;
    }

    setPhase("starting");
    setGlobalError(null);
    setSourceErrors({ speaker: null, microphone: null });
    setConnections(INITIAL_CONNECTIONS);
    setRecordingResult(null);
    setSavedOutput(null);
    accumulatedElapsedMsRef.current = 0;
    startedAtRef.current = null;
    setElapsedSeconds(0);
    dispatchTranscript({ type: "clear" });

    try {
      const captured = await captureAudio(microphoneDeviceId);
      capturedRef.current = captured;
      await refreshMicrophones();

      const recorder = new RecordingController((message) => {
        setGlobalError(`MP3 録音エラー: ${message}`);
      });
      const pipeline = new AudioPipeline();
      pipelineRef.current = pipeline;
      let pipelineReady = false;
      const pendingPcm: Parameters<RecordingController["encode"]>[0][] = [];
      const sampleRate = await pipeline.start(captured, {
        onPcm(batch) {
          if (pipelineReady) {
            recorder.encode(batch);
          } else {
            pendingPcm.push(batch);
          }
        },
        onLevel(source, level) {
          setLevels((current) => ({ ...current, [source]: level }));
        },
        onError(message) {
          setGlobalError(message);
        },
      });
      await recorder.start(sampleRate);
      recorderRef.current = recorder;
      pipelineReady = true;
      pendingPcm.splice(0).forEach((batch) => recorder.encode(batch));

      const createSession = (source: AudioSource): TranslationSession =>
        new TranslationSession(
          source,
          source === "speaker"
            ? captured.speakerTrack
            : captured.microphoneTrack,
          {
            onState(state) {
              setConnections((current) => ({ ...current, [source]: state }));
              if (state === "connected") {
                setSourceErrors((current) => ({ ...current, [source]: null }));
              }
            },
            onTranscript(event) {
              dispatchTranscript(event);
            },
            onFinalize() {
              dispatchTranscript({ type: "finalize-source", source });
            },
            onError(message) {
              setSourceErrors((current) => ({ ...current, [source]: message }));
            },
          },
        );
      const speakerSession = createSession("speaker");
      const microphoneSession = createSession("microphone");
      sessionsRef.current = {
        speaker: speakerSession,
        microphone: microphoneSession,
      };
      await Promise.all([speakerSession.start(), microphoneSession.start()]);

      startedAtRef.current = Date.now();
      setElapsedSeconds(0);
      setPhase("running");
    } catch (error) {
      setGlobalError(errorMessage(error));
      const result = await stopResources();
      setRecordingResult(result);
      setPhase(result ? "finished" : "error");
    }
  };

  const pause = async (): Promise<void> => {
    if (phase !== "running" || !pipelineRef.current) {
      return;
    }

    setPhase("pausing");
    setGlobalError(null);
    Object.values(sessionsRef.current).forEach((session) => session.pause());
    try {
      await pipelineRef.current.pause();
      if (startedAtRef.current !== null) {
        accumulatedElapsedMsRef.current += Date.now() - startedAtRef.current;
        startedAtRef.current = null;
      }
      setElapsedSeconds(
        Math.floor(accumulatedElapsedMsRef.current / 1_000),
      );
      setLevels({ speaker: 0, microphone: 0 });
      setPhase("paused");
    } catch (error) {
      setGlobalError(`一時停止できませんでした: ${errorMessage(error)}`);
      const result = await stopResources();
      setRecordingResult(result);
      setPhase(result ? "finished" : "error");
    }
  };

  const resume = async (): Promise<void> => {
    if (phase !== "paused" || !pipelineRef.current) {
      return;
    }

    setPhase("resuming");
    setGlobalError(null);
    try {
      await pipelineRef.current.resume();
      Object.values(sessionsRef.current).forEach((session) => session.resume());
      startedAtRef.current = Date.now();
      setPhase("running");
    } catch (error) {
      setGlobalError(`再開できませんでした: ${errorMessage(error)}`);
      const result = await stopResources();
      setRecordingResult(result);
      setPhase(result ? "finished" : "error");
    }
  };

  const stop = async (): Promise<void> => {
    if (phase !== "running" && phase !== "paused") {
      return;
    }
    if (phase === "running" && startedAtRef.current !== null) {
      accumulatedElapsedMsRef.current += Date.now() - startedAtRef.current;
      startedAtRef.current = null;
      setElapsedSeconds(
        Math.floor(accumulatedElapsedMsRef.current / 1_000),
      );
    }
    setPhase("stopping");
    const result = await stopResources();
    setRecordingResult(result);
    setPhase(result ? "finished" : "error");
  };

  const exportRecording = async (
    options: ConversationExportOptions,
  ): Promise<void> => {
    if (!recordingResult) {
      return;
    }

    const includeTranscript = options.summary || options.nextActions;
    const transcript: ConversationTranscriptEntry[] = includeTranscript
      ? [
          ...transcripts.speaker.map((entry) => ({
            source: "speaker" as const,
            startedAt: entry.startedAt,
            ...(entry.elapsedMs !== undefined
              ? { elapsedMs: entry.elapsedMs }
              : {}),
            original: entry.original,
            translation: entry.translation,
          })),
          ...transcripts.microphone.map((entry) => ({
            source: "microphone" as const,
            startedAt: entry.startedAt,
            ...(entry.elapsedMs !== undefined
              ? { elapsedMs: entry.elapsedMs }
              : {}),
            original: entry.original,
            translation: entry.translation,
          })),
        ]
      : [];

    setExportingRecording(true);
    setSavedOutput(null);
    setGlobalError(null);
    try {
      const result = await window.desktop.recording.export({
        sessionId: recordingResult.sessionId,
        options,
        transcript,
      });
      if (!result.canceled && result.outputPath) {
        setSavedOutput(result.outputPath);
      }
    } catch (error) {
      setGlobalError(errorMessage(error));
    } finally {
      setExportingRecording(false);
    }
  };

  const discardRecording = async (): Promise<void> => {
    if (!recordingResult) {
      return;
    }
    setDiscardingRecording(true);
    setGlobalError(null);
    try {
      await window.desktop.recording.discard(recordingResult.sessionId);
      setRecordingResult(null);
      setSavedOutput(null);
      accumulatedElapsedMsRef.current = 0;
      startedAtRef.current = null;
      setElapsedSeconds(0);
      setPhase("idle");
    } catch (error) {
      setGlobalError(errorMessage(error));
    } finally {
      setDiscardingRecording(false);
    }
  };

  const sessionIsActive = [
    "starting",
    "running",
    "pausing",
    "paused",
    "resuming",
    "stopping",
  ].includes(phase);
  const canStart =
    Boolean(configuration) &&
    consent &&
    recordingResult === null &&
    (phase === "idle" || phase === "error");
  const showConsentNotice = shouldShowConsentNotice(phase);
  const sessionStatus =
    phase === "running"
      ? "録音中"
      : phase === "paused"
        ? "一時停止中"
        : phase === "starting" || phase === "resuming"
          ? "接続中"
          : phase === "pausing" || phase === "stopping"
            ? "処理中"
            : "待機中";
  const modelSummary = useMemo(() => {
    if (!configuration) {
      return null;
    }
    const { context } = configuration;
    return `${context.translation.model_name} · ${context.location}`;
  }, [configuration]);
  const transcriptAvailable = useMemo(
    () =>
      [...transcripts.speaker, ...transcripts.microphone].some(
        (entry) =>
          entry.original.trim() !== "" || entry.translation.trim() !== "",
      ),
    [transcripts],
  );

  return (
    <main>
      <header className="app-header">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            <img src="/app-icon.png" alt="" />
          </div>
          <div>
            <h1>Realtime Translator</h1>
            <p>英語と日本語を、ひとつの会話としてリアルタイム表示</p>
          </div>
        </div>
        <div className="session-summary">
          <span
            className={`recording-dot ${
              phase === "running"
                ? "is-live"
                : phase === "paused"
                  ? "is-paused"
                  : ""
            }`}
          />
          <span>{sessionStatus}</span>
          <strong>{formatElapsed(elapsedSeconds)}</strong>
        </div>
      </header>

      <section className="control-strip" aria-label="セッション設定">
        <div className="configuration-summary">
          <span className={configuration ? "config-icon is-ready" : "config-icon"} />
          <div>
            <strong>
              {configuration ? modelSummary : "Foundry 設定が必要です"}
            </strong>
            <small>
              {configuration
                ? `${configuration.context.ai_services_account_name} / ${configuration.context.translation.deployment_name}`
                : ".realtime-translation/context.json を選択してください"}
            </small>
          </div>
          <button
            className="button button--quiet"
            type="button"
            disabled={
              sessionIsActive ||
              exportingRecording ||
              discardingRecording
            }
            onClick={() => void chooseConfiguration()}
          >
            SELECT CONFIG
          </button>
        </div>

        <label className="microphone-select">
          <span>マイク</span>
          <select
            value={microphoneDeviceId}
            disabled={sessionIsActive}
            onChange={(event) => setMicrophoneDeviceId(event.target.value)}
          >
            {microphones.length === 0 ? (
              <option value="">既定のマイク</option>
            ) : (
              microphones.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `マイク ${index + 1}`}
                </option>
              ))
            )}
          </select>
        </label>

        <SessionControls
          phase={phase}
          canStart={canStart}
          onStart={() => void start()}
          onPause={() => void pause()}
          onResume={() => void resume()}
          onStop={() => void stop()}
        />
      </section>

      {configurationError ? (
        <div className="global-message global-message--error">
          {configurationError}
        </div>
      ) : null}
      {globalError ? (
        <div className="global-message global-message--error">{globalError}</div>
      ) : null}

      {showConsentNotice ? (
        <section className="notice-bar">
          <div>
            <strong>録音と Azure 送信について</strong>
            <p>
              既定スピーカーの全システム音声とマイクを取得し、文字起こし・翻訳のため
              Azure へ送信します。参加者から録音同意を得て、headset を利用してください。
            </p>
          </div>
          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>同意を確認しました</span>
          </label>
        </section>
      ) : null}

      <ConversationPane
        transcripts={transcripts}
        connections={connections}
        levels={levels}
        sourceErrors={sourceErrors}
      />

      {recordingResult ? (
        <ExportPanel
          result={recordingResult}
          onExport={exportRecording}
          onDiscard={discardRecording}
          exporting={exportingRecording}
          discarding={discardingRecording}
          insightsAvailable={Boolean(configuration?.context.insights)}
          transcriptAvailable={transcriptAvailable}
          savedOutput={savedOutput}
          error={globalError}
        />
      ) : null}

      <footer>
        <span>AI 翻訳音声は再生しません。混合 MP3 は端末内で生成されます。</span>
        <span>
          {configuration
            ? `Realtime モデル提供終了予定: ${configuration.context.model_retirement_date}`
            : "Azure API key は使用しません"}
        </span>
      </footer>
    </main>
  );
}

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
  RecordingStopResult,
  RecordingTrack,
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
}

function LevelMeter({ label, value }: LevelMeterProps): React.JSX.Element {
  return (
    <div className="level" aria-label={`${label} 音量 ${Math.round(value * 100)}%`}>
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

interface TranscriptPaneProps {
  source: AudioSource;
  entries: TranscriptEntry[];
  connection: TranslationConnectionState;
  level: number;
  error: string | null;
}

function TranscriptPane({
  source,
  entries,
  connection,
  level,
  error,
}: TranscriptPaneProps): React.JSX.Element {
  const isSpeaker = source === "speaker";
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
    <section className="transcript-pane" aria-labelledby={`${source}-title`}>
      <header className="transcript-pane__header">
        <div>
          <p className="eyebrow">{isSpeaker ? "SPEAKER OUTPUT" : "MICROPHONE INPUT"}</p>
          <h2 id={`${source}-title`}>
            {isSpeaker ? "相手の発言" : "自分の発言"}
          </h2>
          <p className="language-pair">
            {isSpeaker ? "English → 日本語" : "日本語 → English"}
          </p>
        </div>
        <span className={`status status--${connection}`}>
          {connectionLabel(connection)}
        </span>
      </header>

      <LevelMeter
        label={isSpeaker ? "スピーカー" : "マイク"}
        value={level}
      />

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="transcript-list" ref={listRef}>
        {entries.length === 0 ? (
          <div className="empty-transcript">
            <span className="empty-transcript__mark">Aa</span>
            <p>会話を開始すると原文と訳文がここに表示されます。</p>
          </div>
        ) : (
          entries.map((entry) => (
            <article className="utterance" key={entry.id}>
              <time>{formatTime(entry.startedAt)}</time>
              <div className="utterance__part">
                <span className="utterance__label">
                  {isSpeaker ? "EN" : "JA"} 原文
                </span>
                <p className={entry.originalFinal ? "" : "is-partial"}>
                  {entry.original || "…"}
                </p>
              </div>
              <div className="utterance__divider" />
              <div className="utterance__part utterance__part--translation">
                <span className="utterance__label">
                  {isSpeaker ? "JA" : "EN"} 訳文
                </span>
                <p className={entry.translationFinal ? "" : "is-partial"}>
                  {entry.translation || "…"}
                </p>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

interface ExportPanelProps {
  result: RecordingStopResult;
  onSave(track: RecordingTrack): Promise<void>;
  onDiscard(): Promise<void>;
  savingTrack: RecordingTrack | null;
  discarding: boolean;
  savedPaths: Partial<Record<RecordingTrack, string>>;
  error: string | null;
}

export function ExportPanel({
  result,
  onSave,
  onDiscard,
  savingTrack,
  discarding,
  savedPaths,
  error,
}: ExportPanelProps): React.JSX.Element {
  const exports: Array<{
    track: RecordingTrack;
    title: string;
    detail: string;
  }> = [
    {
      track: "speaker",
      title: "SPEAKER MP3",
      detail: "スピーカー出力のみ",
    },
    {
      track: "microphone",
      title: "MICROPHONE MP3",
      detail: "マイク入力のみ",
    },
    {
      track: "mix",
      title: "FULL MIX MP3",
      detail: "相手と自分をミックス",
    },
  ];

  const savedCount = Object.keys(savedPaths).length;

  return (
    <div className="export-backdrop">
      <section
        className="export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
      >
        <div className="export-panel__intro">
          <p className="eyebrow">SESSION COMPLETE</p>
          <h2 id="export-title">録音を保存しますか？</h2>
          <p>
            保存する音声を選んでください。保存しない音声は、この画面を閉じると削除されます。
          </p>
        </div>
        <div className="export-controls">
          <div className="export-actions">
            {exports.map(({ track, title, detail }) => {
              const savedPath = savedPaths[track];
              return (
                <button
                  className={`export-button ${savedPath ? "is-saved" : ""}`}
                  key={track}
                  type="button"
                  disabled={
                    savingTrack !== null ||
                    discarding ||
                    result.tracks[track].byteLength === 0 ||
                    Boolean(savedPath)
                  }
                  onClick={() => void onSave(track)}
                >
                  <span>
                    {savedPath
                      ? "SAVED"
                      : savingTrack === track
                        ? "SAVING..."
                        : `SAVE ${title}`}
                  </span>
                  <small>{savedPath ?? detail}</small>
                </button>
              );
            })}
          </div>
          {error ? (
            <div className="global-message global-message--error">{error}</div>
          ) : null}
          <div className="export-panel__footer">
            <p>
              {savedCount > 0
                ? `${savedCount} 件を保存しました。`
                : "保存しない場合、一時録音は端末から削除されます。"}
            </p>
            <button
              className="button button--discard"
              type="button"
              disabled={savingTrack !== null || discarding}
              onClick={() => void onDiscard()}
            >
              {discarding
                ? "CLOSING..."
                : savedCount > 0
                  ? "DONE"
                  : "DISCARD & CLOSE"}
            </button>
          </div>
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
  const [savingTrack, setSavingTrack] = useState<RecordingTrack | null>(null);
  const [discardingRecording, setDiscardingRecording] = useState(false);
  const [savedPaths, setSavedPaths] = useState<
    Partial<Record<RecordingTrack, string>>
  >({});
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
    setSavedPaths({});
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

  const saveRecording = async (track: RecordingTrack): Promise<void> => {
    if (!recordingResult) {
      return;
    }
    const names: Record<RecordingTrack, string> = {
      speaker: "speaker.mp3",
      microphone: "microphone.mp3",
      mix: "conversation-mix.mp3",
    };

    setSavingTrack(track);
    setGlobalError(null);
    try {
      const result = await window.desktop.recording.save({
        sessionId: recordingResult.sessionId,
        track,
        suggestedName: names[track],
      });
      if (!result.canceled && result.filePath) {
        setSavedPaths((current) => ({
          ...current,
          [track]: result.filePath,
        }));
      }
    } catch (error) {
      setGlobalError(errorMessage(error));
    } finally {
      setSavingTrack(null);
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
      setSavedPaths({});
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

  return (
    <main>
      <header className="app-header">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            <img src="/app-icon.png" alt="" />
          </div>
          <div>
            <h1>Teams Realtime Translator</h1>
            <p>英語と日本語を、話者ごとにリアルタイム表示</p>
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
            disabled={sessionIsActive}
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

      <section className="notice-bar">
        <div>
          <strong>録音と Azure 送信について</strong>
          <p>
            既定スピーカーの全システム音声とマイクを取得し、文字起こし・翻訳のため
            Azure へ送信します。Teams の相手から録音同意を得て、headset を利用してください。
          </p>
        </div>
        <label className="consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={sessionIsActive}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>同意を確認しました</span>
        </label>
      </section>

      <section className="transcript-grid">
        <TranscriptPane
          source="speaker"
          entries={transcripts.speaker}
          connection={connections.speaker}
          level={levels.speaker}
          error={sourceErrors.speaker}
        />
        <TranscriptPane
          source="microphone"
          entries={transcripts.microphone}
          connection={connections.microphone}
          level={levels.microphone}
          error={sourceErrors.microphone}
        />
      </section>

      {recordingResult ? (
        <ExportPanel
          result={recordingResult}
          onSave={saveRecording}
          onDiscard={discardRecording}
          savingTrack={savingTrack}
          discarding={discardingRecording}
          savedPaths={savedPaths}
          error={globalError}
        />
      ) : null}

      <footer>
        <span>AI 翻訳音声は再生しません。MP3 は端末内で生成されます。</span>
        <span>
          {configuration
            ? `モデル提供終了予定: ${configuration.context.model_retirement_date}`
            : "Azure API key は使用しません"}
        </span>
      </footer>
    </main>
  );
}

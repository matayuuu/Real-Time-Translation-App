import type { AudioSource, TranslationSessionSecret } from "@shared/contracts";

export type TranslationConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed"
  | "error";

export interface TranscriptDelta {
  source: AudioSource;
  side: "input" | "output";
  kind: "delta" | "done";
  text: string;
  itemId?: string;
  elapsedMs?: number;
}

export interface TranslationSessionCallbacks {
  onState(state: TranslationConnectionState): void;
  onTranscript(event: TranscriptDelta): void;
  onFinalize(): void;
  onError(message: string): void;
}

interface RealtimeEvent {
  type?: unknown;
  delta?: unknown;
  text?: unknown;
  transcript?: unknown;
  item_id?: unknown;
  response_id?: unknown;
  elapsed_ms?: unknown;
  error?: { message?: unknown };
}

const CONNECT_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 4_000;
const INPUT_TRANSCRIPT_STALL_MS = 45_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000] as const;
const INPUT_TRANSCRIPTION_FAILURE_EVENTS = new Set([
  "conversation.item.input_audio_transcription.failed",
]);

function eventText(event: RealtimeEvent): string {
  for (const candidate of [event.delta, event.text, event.transcript]) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
}

export function parseTranscriptEvent(
  source: AudioSource,
  event: RealtimeEvent,
  streamId = "stream",
): TranscriptDelta | null {
  if (typeof event.type !== "string") {
    return null;
  }

  const mappings: Record<
    string,
    Pick<TranscriptDelta, "side" | "kind">
  > = {
    "session.input_transcript.delta": { side: "input", kind: "delta" },
    "session.input_transcript.completed": { side: "input", kind: "done" },
    "session.input_transcript.done": { side: "input", kind: "done" },
    "conversation.item.input_audio_transcription.delta": {
      side: "input",
      kind: "delta",
    },
    "conversation.item.input_audio_transcription.completed": {
      side: "input",
      kind: "done",
    },
    "session.output_transcript.delta": { side: "output", kind: "delta" },
    "session.output_transcript.completed": { side: "output", kind: "done" },
    "session.output_transcript.done": { side: "output", kind: "done" },
    "response.text.delta": { side: "output", kind: "delta" },
    "response.text.done": { side: "output", kind: "done" },
    "response.output_text.delta": { side: "output", kind: "delta" },
    "response.output_text.done": { side: "output", kind: "done" },
    "response.output_audio_transcript.delta": {
      side: "output",
      kind: "delta",
    },
    "response.output_audio_transcript.done": {
      side: "output",
      kind: "done",
    },
  };
  const mapping = mappings[event.type];
  if (!mapping) {
    return null;
  }

  const elapsedMs =
    typeof event.elapsed_ms === "number" ? event.elapsed_ms : undefined;
  const explicitItemId =
    typeof event.item_id === "string"
      ? event.item_id
      : typeof event.response_id === "string"
        ? event.response_id
        : undefined;
  const itemId =
    elapsedMs !== undefined
      ? `${streamId}-${Math.floor(elapsedMs / 15_000)}`
      : explicitItemId;
  const rawText = eventText(event);
  const text =
    mapping.kind === "delta" ? rawText.replaceAll("\uFFFD", "") : rawText;
  if (mapping.kind === "delta" && text === "") {
    return null;
  }
  const result: TranscriptDelta = {
    source,
    ...mapping,
    text,
  };
  if (itemId) {
    result.itemId = itemId;
  }
  if (elapsedMs !== undefined) {
    result.elapsedMs = elapsedMs;
  }
  return result;
}

function waitForDataChannelOpen(
  channel: RTCDataChannel,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("error", onError);
      channel.removeEventListener("close", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Realtime data channel failed to open."));
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const timeout = window.setTimeout(
      () => {
        cleanup();
        reject(new Error("Realtime data channel timed out."));
      },
      CONNECT_TIMEOUT_MS,
    );
    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("error", onError, { once: true });
    channel.addEventListener("close", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class TranslationSession {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private stopRequested = false;
  private reconnecting = false;
  private reconnectTask: Promise<void> | null = null;
  private connectionController: AbortController | null = null;
  private closedEventResolver: (() => void) | null = null;
  private streamSequence = 0;
  private currentStreamId = "";
  private inputTranscriptMissingSince: number | null = null;

  public constructor(
    private readonly source: AudioSource,
    private readonly audioTrack: MediaStreamTrack,
    private readonly callbacks: TranslationSessionCallbacks,
  ) {}

  public async start(secret?: TranslationSessionSecret): Promise<void> {
    this.stopRequested = false;
    await this.connect("connecting", secret);
  }

  public pause(): void {
    this.audioTrack.enabled = false;
  }

  public resume(): void {
    if (!this.stopRequested) {
      this.audioTrack.enabled = true;
    }
  }

  public async prepareResume(): Promise<void> {
    await this.reconnectTask;
    if (this.stopRequested) {
      throw new Error("The translation session has already ended.");
    }
    if (this.dataChannel?.readyState !== "open") {
      await this.reconnect(`${this.source} Realtime session is resuming.`);
    }
    if (this.stopRequested || !this.isConnected()) {
      throw new Error(`${this.source} Realtime session could not reconnect.`);
    }
  }

  public async close(): Promise<void> {
    this.stopRequested = true;
    this.audioTrack.enabled = false;
    this.connectionController?.abort();
    this.callbacks.onState("closing");
    const channel = this.dataChannel;
    let timeout: number | undefined;
    try {
      if (channel?.readyState === "open") {
        const closed = new Promise<void>((resolve) => {
          this.closedEventResolver = resolve;
        });
        channel.send(JSON.stringify({ type: "session.close" }));
        await Promise.race([
          closed,
          new Promise<void>((resolve) => {
            timeout = window.setTimeout(resolve, CLOSE_TIMEOUT_MS);
          }),
        ]);
      }
    } finally {
      window.clearTimeout(timeout);
      this.callbacks.onFinalize();
      this.disposeConnection();
      this.callbacks.onState("closed");
    }
  }

  private async connect(
    initialState: "connecting" | "reconnecting",
    initialSecret?: TranslationSessionSecret,
  ): Promise<void> {
    if (this.stopRequested) {
      return;
    }
    this.connectionController?.abort();
    const controller = new AbortController();
    this.connectionController = controller;
    this.callbacks.onState(initialState);
    this.streamSequence += 1;
    this.currentStreamId = `${this.source}-${this.streamSequence}`;
    this.inputTranscriptMissingSince = null;
    const secret =
      initialSecret &&
      (initialSecret.expiresAt === undefined || initialSecret.expiresAt * 1_000 > Date.now() + 5_000)
        ? initialSecret
        : await window.desktop.translation.createSecret({
            source: this.source,
            targetLanguage: "ja",
          });
    controller.signal.throwIfAborted();

    const peerConnection = new RTCPeerConnection();
    this.peerConnection = peerConnection;
    const stream = new MediaStream([this.audioTrack]);
    peerConnection.addTrack(this.audioTrack, stream);
    peerConnection.ontrack = (event) => {
      event.track.enabled = false;
    };
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === "failed" || state === "disconnected") {
        void this.reconnect(
          `${this.source} Realtime connection became ${state}.`,
        );
      }
    };

    const channel = peerConnection.createDataChannel("oai-events");
    this.dataChannel = channel;
    channel.onmessage = (message) => {
      this.handleMessage(message.data);
    };
    channel.onerror = () => {
      void this.reconnect(`${this.source} Realtime data channel failed.`);
    };
    channel.onclose = () => {
      if (!this.stopRequested) {
        void this.reconnect(`${this.source} Realtime data channel closed.`);
      }
    };

    const offer = await peerConnection.createOffer();
    controller.signal.throwIfAborted();
    await peerConnection.setLocalDescription(offer);
    controller.signal.throwIfAborted();
    if (!offer.sdp) {
      throw new Error("Realtime WebRTC offer did not contain SDP.");
    }
    const response = await fetch(
      `${secret.endpoint}/openai/v1/realtime/translations/calls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret.value}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        ]),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Realtime SDP negotiation failed (${response.status} ${response.statusText}).`,
      );
    }
    const answer = await response.text();
    controller.signal.throwIfAborted();
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answer,
    });
    controller.signal.throwIfAborted();
    await waitForDataChannelOpen(channel, controller.signal);
    controller.signal.throwIfAborted();
    this.callbacks.onState("connected");
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      this.callbacks.onError("Realtime API returned invalid JSON.");
      return;
    }

    const transcript = parseTranscriptEvent(
      this.source,
      event,
      this.currentStreamId,
    );
    if (transcript) {
      this.callbacks.onTranscript(transcript);
      this.monitorTranscriptHealth(transcript);
      return;
    }
    if (event.type === "session.closed") {
      this.closedEventResolver?.();
      this.closedEventResolver = null;
      return;
    }
    if (event.type === "error") {
      const message =
        typeof event.error?.message === "string"
          ? event.error.message
          : "Realtime API returned an error.";
      this.callbacks.onError(message);
      return;
    }
    if (
      typeof event.type === "string" &&
      INPUT_TRANSCRIPTION_FAILURE_EVENTS.has(event.type)
    ) {
      const message =
        typeof event.error?.message === "string"
          ? event.error.message
          : `${this.source} source transcription failed.`;
      void this.reconnect(message);
    }
  }

  private monitorTranscriptHealth(transcript: TranscriptDelta): void {
    if (transcript.text === "") {
      return;
    }
    if (transcript.side === "input") {
      this.inputTranscriptMissingSince = null;
      return;
    }

    const now = Date.now();
    if (this.inputTranscriptMissingSince === null) {
      this.inputTranscriptMissingSince = now;
      return;
    }
    if (now - this.inputTranscriptMissingSince >= INPUT_TRANSCRIPT_STALL_MS) {
      this.inputTranscriptMissingSince = now;
      void this.reconnect(
        `${this.source} source transcript stalled while translation continued.`,
      );
    }
  }

  private reconnect(reason: string): Promise<void> {
    if (this.stopRequested || this.reconnecting) {
      return this.reconnectTask ?? Promise.resolve();
    }
    this.reconnecting = true;
    this.reconnectTask = this.reconnectWithRetry(reason).finally(() => {
      this.reconnecting = false;
      this.reconnectTask = null;
    });
    return this.reconnectTask;
  }

  private async reconnectWithRetry(reason: string): Promise<void> {
    this.callbacks.onError(reason);
    this.callbacks.onFinalize();
    this.disposeConnection();

    for (const delay of RECONNECT_DELAYS_MS) {
      if (this.stopRequested) {
        break;
      }
      this.callbacks.onState("reconnecting");
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      if (this.stopRequested) {
        break;
      }
      try {
        await this.connect("reconnecting");
        return;
      } catch (error) {
        this.disposeConnection();
        if (this.stopRequested) {
          break;
        }
        this.callbacks.onError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (!this.stopRequested) {
      this.callbacks.onState("error");
    }
  }

  private isConnected(): boolean {
    return this.dataChannel?.readyState === "open";
  }

  private disposeConnection(): void {
    this.connectionController?.abort();
    this.connectionController = null;
    if (this.dataChannel) {
      this.dataChannel.onmessage = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.closedEventResolver = null;
  }
}

import type { AudioSource } from "@shared/contracts";

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

function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Realtime data channel timed out."));
    }, CONNECT_TIMEOUT_MS);
    channel.addEventListener(
      "open",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    channel.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        reject(new Error("Realtime data channel failed to open."));
      },
      { once: true },
    );
  });
}

export class TranslationSession {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private stopRequested = false;
  private reconnecting = false;
  private closedEventResolver: (() => void) | null = null;
  private streamSequence = 0;
  private currentStreamId = "";
  private inputTranscriptMissingSince: number | null = null;

  public constructor(
    private readonly source: AudioSource,
    private readonly audioTrack: MediaStreamTrack,
    private readonly callbacks: TranslationSessionCallbacks,
  ) {}

  public async start(): Promise<void> {
    this.stopRequested = false;
    await this.connect("connecting");
  }

  public pause(): void {
    this.audioTrack.enabled = false;
  }

  public resume(): void {
    if (!this.stopRequested) {
      this.audioTrack.enabled = true;
    }
  }

  public async close(): Promise<void> {
    this.stopRequested = true;
    this.callbacks.onState("closing");
    const channel = this.dataChannel;
    if (channel?.readyState === "open") {
      const closed = new Promise<void>((resolve) => {
        this.closedEventResolver = resolve;
      });
      channel.send(JSON.stringify({ type: "session.close" }));
      await Promise.race([
        closed,
        new Promise<void>((resolve) =>
          window.setTimeout(resolve, CLOSE_TIMEOUT_MS),
        ),
      ]);
    }
    this.callbacks.onFinalize();
    this.disposeConnection();
    this.callbacks.onState("closed");
  }

  private async connect(
    initialState: "connecting" | "reconnecting",
  ): Promise<void> {
    this.callbacks.onState(initialState);
    this.streamSequence += 1;
    this.currentStreamId = `${this.source}-${this.streamSequence}`;
    this.inputTranscriptMissingSince = null;
    const targetLanguage = this.source === "speaker" ? "ja" : "en";
    const secret = await window.desktop.translation.createSecret({
      source: this.source,
      targetLanguage,
    });
    if (this.stopRequested) {
      return;
    }

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
    await peerConnection.setLocalDescription(offer);
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
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Realtime SDP negotiation failed (${response.status} ${response.statusText}).`,
      );
    }
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
    await waitForDataChannelOpen(channel);
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

  private async reconnect(reason: string): Promise<void> {
    if (this.stopRequested || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    this.callbacks.onError(reason);
    this.callbacks.onFinalize();
    this.disposeConnection();

    for (const delay of RECONNECT_DELAYS_MS) {
      if (this.stopRequested) {
        break;
      }
      this.callbacks.onState("reconnecting");
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      try {
        await this.connect("reconnecting");
        this.reconnecting = false;
        return;
      } catch (error) {
        this.disposeConnection();
        this.callbacks.onError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    this.reconnecting = false;
    if (!this.stopRequested) {
      this.callbacks.onState("error");
    }
  }

  private disposeConnection(): void {
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

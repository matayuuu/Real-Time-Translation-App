import type { AudioSource } from "@shared/contracts";

import type { TranscriptDelta } from "../realtime/translation-session";

export interface TranscriptEntry {
  id: string;
  original: string;
  translation: string;
  originalFinal: boolean;
  translationFinal: boolean;
  startedAt: string;
}

export interface TranscriptState {
  speaker: TranscriptEntry[];
  microphone: TranscriptEntry[];
}

export const EMPTY_TRANSCRIPTS: TranscriptState = {
  speaker: [],
  microphone: [],
};

export type TranscriptAction =
  | TranscriptDelta
  | { type: "clear" }
  | { type: "finalize-source"; source: AudioSource };

function createEntry(id: string): TranscriptEntry {
  return {
    id,
    original: "",
    translation: "",
    originalFinal: false,
    translationFinal: false,
    startedAt: new Date().toISOString(),
  };
}

function appendText(current: string, incoming: string, done: boolean): string {
  if (!incoming) {
    return current;
  }
  if (done) {
    return incoming;
  }
  return `${current}${incoming}`;
}

function reduceSource(
  entries: TranscriptEntry[],
  event: TranscriptDelta,
): TranscriptEntry[] {
  const last = entries.at(-1);
  const explicitMatch = event.itemId
    ? entries.findIndex((entry) => entry.id === event.itemId)
    : -1;
  const needsNewEntry =
    explicitMatch < 0 &&
    (!last ||
      event.elapsedMs !== undefined ||
      (last.originalFinal &&
        last.translationFinal &&
        (event.kind === "delta" || event.text !== "")));

  const next = entries.map((entry) => ({ ...entry }));
  let index = explicitMatch;
  if (needsNewEntry) {
    const previous = next.at(-1);
    if (previous) {
      previous.originalFinal = true;
      previous.translationFinal = true;
    }
    const id =
      event.itemId ??
      `${event.source}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    next.push(createEntry(id));
    index = next.length - 1;
  } else if (index < 0) {
    index = next.length - 1;
  }

  const entry = next[index];
  if (!entry) {
    return entries;
  }
  const isDone = event.kind === "done";
  if (event.side === "input") {
    entry.original = appendText(entry.original, event.text, isDone);
    entry.originalFinal = isDone;
  } else {
    entry.translation = appendText(entry.translation, event.text, isDone);
    entry.translationFinal = isDone;
  }
  return next.slice(-200);
}

export function transcriptReducer(
  state: TranscriptState,
  event: TranscriptAction,
): TranscriptState {
  if ("type" in event && event.type === "clear") {
    return EMPTY_TRANSCRIPTS;
  }
  if ("type" in event && event.type === "finalize-source") {
    return {
      ...state,
      [event.source]: state[event.source].map((entry) => ({
        ...entry,
        originalFinal: true,
        translationFinal: true,
      })),
    };
  }

  const source = event.source as AudioSource;
  return {
    ...state,
    [source]: reduceSource(state[source], event),
  };
}

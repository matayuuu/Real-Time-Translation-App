export type AudioSource = "speaker" | "microphone";
export type RecordingTrack = AudioSource | "mix";

export interface ModelDeploymentContext {
  deployment_name: string;
  model_name: string;
  model_version: string;
  sku: string;
  capacity: number;
}

export interface RealtimeTranslationContext {
  schema_version: 1;
  setup_status: "complete";
  generated_at: string;
  subscription_id: string;
  resource_group_name: string;
  location: string;
  ai_services_account_name: string;
  openai_endpoint: string;
  foundry_project_name: string;
  foundry_project_endpoint: string;
  translation: ModelDeploymentContext;
  transcription: ModelDeploymentContext;
  model_retirement_date: string;
}

export interface AppConfiguration {
  contextPath: string;
  context: RealtimeTranslationContext;
}

export interface TranslationSecretRequest {
  source: AudioSource;
  targetLanguage: "en" | "ja";
}

export interface TranslationSessionSecret {
  value: string;
  endpoint: string;
  expiresAt?: number;
}

export interface RecordingSessionInfo {
  sessionId: string;
  startedAt: string;
  sampleRate: number;
}

export interface RecordingAppendPayload {
  sessionId: string;
  track: RecordingTrack;
  chunk: Uint8Array;
}

export interface RecordingStopResult {
  sessionId: string;
  tracks: Record<RecordingTrack, { byteLength: number }>;
}

export interface SaveRecordingRequest {
  sessionId: string;
  track: RecordingTrack;
  suggestedName: string;
}

export interface SaveRecordingResult {
  canceled: boolean;
  filePath?: string;
}

export type AppEvent =
  | {
      type: "configuration-changed";
      configuration: AppConfiguration;
    }
  | {
      type: "configuration-error";
      message: string;
    };

export interface DesktopBridge {
  configuration: {
    get(): Promise<AppConfiguration | null>;
    choose(): Promise<AppConfiguration | null>;
  };
  translation: {
    createSecret(request: TranslationSecretRequest): Promise<TranslationSessionSecret>;
  };
  recording: {
    start(sampleRate: number): Promise<RecordingSessionInfo>;
    append(payload: RecordingAppendPayload): Promise<void>;
    stop(sessionId: string): Promise<RecordingStopResult>;
    save(request: SaveRecordingRequest): Promise<SaveRecordingResult>;
    discard(sessionId: string): Promise<void>;
  };
  events: {
    subscribe(listener: (event: AppEvent) => void): () => void;
  };
}

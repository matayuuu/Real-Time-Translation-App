export type AudioSource = "speaker" | "microphone";

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
  insights?: ModelDeploymentContext;
  model_retirement_date: string;
}

export interface AppConfiguration {
  contextPath: string;
  context: RealtimeTranslationContext;
}

export interface ApplicationInfo {
  version: string;
  lastUpdatedAt: string;
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
  chunk: Uint8Array;
}

export interface RecordingStopResult {
  sessionId: string;
  byteLength: number;
}

export interface ConversationExportOptions {
  summary: boolean;
  nextActions: boolean;
}

export interface ConversationTranscriptEntry {
  source: AudioSource;
  startedAt: string;
  elapsedMs?: number;
  original: string;
  translation: string;
}

export interface ExportRecordingRequest {
  sessionId: string;
  options: ConversationExportOptions;
  transcript: ConversationTranscriptEntry[];
}

export interface ExportRecordingResult {
  canceled: boolean;
  outputPath?: string;
  kind?: "audio" | "bundle";
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
  application: {
    getInfo(): Promise<ApplicationInfo>;
  };
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
    export(request: ExportRecordingRequest): Promise<ExportRecordingResult>;
    discard(sessionId: string): Promise<void>;
  };
  events: {
    subscribe(listener: (event: AppEvent) => void): () => void;
  };
}

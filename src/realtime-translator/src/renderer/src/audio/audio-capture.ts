import type { AudioSource } from "@shared/contracts";

export interface CapturedAudio {
  speakerStream: MediaStream;
  microphoneStream: MediaStream;
  speakerTrack: MediaStreamTrack;
  microphoneTrack: MediaStreamTrack;
  stop(): void;
}

export interface PcmBatch {
  speaker: Float32Array;
  microphone: Float32Array;
  mix: Float32Array;
}

export interface AudioPipelineOptions {
  onPcm(batch: PcmBatch): void;
  onLevel(source: AudioSource, level: number): void;
  onError?(message: string): void;
}

function requireAudioTrack(stream: MediaStream, label: string): MediaStreamTrack {
  const track = stream.getAudioTracks()[0];
  if (!track) {
    throw new Error(`${label} の音声トラックを取得できませんでした。`);
  }
  return track;
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

export async function captureAudio(
  microphoneDeviceId: string,
): Promise<CapturedAudio> {
  const speakerStream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });
  speakerStream.getVideoTracks().forEach((track) => {
    track.stop();
    speakerStream.removeTrack(track);
  });
  let speakerTrack: MediaStreamTrack;
  try {
    speakerTrack = requireAudioTrack(speakerStream, "スピーカー");
  } catch (error) {
    speakerStream.getTracks().forEach((track) => track.stop());
    throw error;
  }

  let microphoneStream: MediaStream;
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(microphoneDeviceId
          ? { deviceId: { exact: microphoneDeviceId } }
          : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (error) {
    speakerStream.getTracks().forEach((track) => track.stop());
    throw error;
  }

  let microphoneTrack: MediaStreamTrack;
  try {
    microphoneTrack = requireAudioTrack(microphoneStream, "マイク");
  } catch (error) {
    speakerStream.getTracks().forEach((track) => track.stop());
    microphoneStream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  return {
    speakerStream,
    microphoneStream,
    speakerTrack,
    microphoneTrack,
    stop() {
      speakerStream.getTracks().forEach((track) => track.stop());
      microphoneStream.getTracks().forEach((track) => track.stop());
    },
  };
}

export function calculatePcmLevel(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, rms * 4);
}

export class AudioPipeline {
  private context: AudioContext | null = null;
  private pauseRequested = false;

  public async start(
    captured: CapturedAudio,
    options: AudioPipelineOptions,
  ): Promise<number> {
    if (this.context) {
      throw new Error("Audio pipeline is already running.");
    }

    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    this.pauseRequested = false;
    context.onstatechange = () => {
      if (context.state === "suspended" && !this.pauseRequested) {
        void context.resume().catch((error: unknown) => {
          options.onError?.(
            `Audio pipeline could not resume: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      } else if (context.state === "closed" && this.context === context) {
        options.onError?.("Audio pipeline closed unexpectedly.");
      }
    };
    await context.audioWorklet.addModule("/capture-processor.js");

    const speakerSource = context.createMediaStreamSource(
      captured.speakerStream,
    );
    const microphoneSource = context.createMediaStreamSource(
      captured.microphoneStream,
    );
    const speakerMono = new GainNode(context, {
      gain: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    const microphoneMono = new GainNode(context, {
      gain: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    const merger = context.createChannelMerger(2);
    const processor = new AudioWorkletNode(context, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    const mutedOutput = new GainNode(context, { gain: 0 });

    speakerSource.connect(speakerMono);
    microphoneSource.connect(microphoneMono);
    speakerMono.connect(merger, 0, 0);
    microphoneMono.connect(merger, 0, 1);
    merger.connect(processor);
    processor.connect(mutedOutput).connect(context.destination);
    processor.port.onmessage = (event: MessageEvent<PcmBatch>) => {
      const batch = event.data;
      options.onLevel("speaker", calculatePcmLevel(batch.speaker));
      options.onLevel("microphone", calculatePcmLevel(batch.microphone));
      options.onPcm(batch);
    };
    await context.resume();
    return context.sampleRate;
  }

  public async pause(): Promise<void> {
    if (!this.context) {
      throw new Error("Audio pipeline is not running.");
    }
    this.pauseRequested = true;
    try {
      await this.context.suspend();
    } catch (error) {
      this.pauseRequested = false;
      throw error;
    }
  }

  public async resume(): Promise<void> {
    if (!this.context) {
      throw new Error("Audio pipeline is not running.");
    }
    await this.context.resume();
    this.pauseRequested = false;
  }

  public async stop(): Promise<void> {
    if (this.context) {
      this.context.onstatechange = null;
      await this.context.close();
      this.context = null;
    }
    this.pauseRequested = false;
  }
}

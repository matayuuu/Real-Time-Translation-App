import type { AudioSource } from "@shared/contracts";

export interface CapturedAudio {
  speakerStream: MediaStream;
  microphoneStream: MediaStream;
  speakerTrack: MediaStreamTrack;
  microphoneTrack: MediaStreamTrack;
  stop(): void;
}

export interface PcmBatch {
  mix: Float32Array;
}

export interface AudioPipelineOptions {
  onPcm(batch: PcmBatch): void;
  onLevel(source: AudioSource, level: number): void;
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

function calculateLevel(
  analyser: AnalyserNode,
  buffer: Float32Array<ArrayBuffer>,
): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / buffer.length);
  return Math.min(1, rms * 4);
}

export class AudioPipeline {
  private context: AudioContext | null = null;
  private animationFrame: number | null = null;

  public async start(
    captured: CapturedAudio,
    options: AudioPipelineOptions,
  ): Promise<number> {
    if (this.context) {
      throw new Error("Audio pipeline is already running.");
    }

    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
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
    const speakerAnalyser = new AnalyserNode(context, {
      fftSize: 512,
      smoothingTimeConstant: 0.75,
    });
    const microphoneAnalyser = new AnalyserNode(context, {
      fftSize: 512,
      smoothingTimeConstant: 0.75,
    });

    speakerSource.connect(speakerMono);
    microphoneSource.connect(microphoneMono);
    speakerMono.connect(merger, 0, 0);
    microphoneMono.connect(merger, 0, 1);
    speakerMono.connect(speakerAnalyser);
    microphoneMono.connect(microphoneAnalyser);
    merger.connect(processor);
    processor.connect(mutedOutput).connect(context.destination);
    processor.port.onmessage = (event: MessageEvent<PcmBatch>) => {
      options.onPcm(event.data);
    };

    const speakerLevelData = new Float32Array(
      new ArrayBuffer(speakerAnalyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
    );
    const microphoneLevelData = new Float32Array(
      new ArrayBuffer(
        microphoneAnalyser.fftSize * Float32Array.BYTES_PER_ELEMENT,
      ),
    );
    const updateLevels = (): void => {
      options.onLevel(
        "speaker",
        calculateLevel(speakerAnalyser, speakerLevelData),
      );
      options.onLevel(
        "microphone",
        calculateLevel(microphoneAnalyser, microphoneLevelData),
      );
      this.animationFrame = requestAnimationFrame(updateLevels);
    };
    updateLevels();
    await context.resume();
    return context.sampleRate;
  }

  public async stop(): Promise<void> {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }
}

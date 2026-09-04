class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = 4608;
    this.speaker = new Float32Array(this.batchSize);
    this.microphone = new Float32Array(this.batchSize);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const channels = inputs[0] || [];
    const speakerInput = channels[0] || new Float32Array(128);
    const microphoneInput =
      channels[1] || new Float32Array(speakerInput.length);
    let sourceOffset = 0;

    while (sourceOffset < speakerInput.length) {
      const writable = Math.min(
        this.batchSize - this.offset,
        speakerInput.length - sourceOffset,
      );
      this.speaker.set(
        speakerInput.subarray(sourceOffset, sourceOffset + writable),
        this.offset,
      );
      this.microphone.set(
        microphoneInput.subarray(sourceOffset, sourceOffset + writable),
        this.offset,
      );
      this.offset += writable;
      sourceOffset += writable;

      if (this.offset === this.batchSize) {
        const speaker = this.speaker;
        const microphone = this.microphone;
        const mix = new Float32Array(this.batchSize);
        for (let index = 0; index < this.batchSize; index += 1) {
          const value = (speaker[index] + microphone[index]) * 0.5;
          mix[index] = Math.max(-1, Math.min(1, value));
        }
        this.port.postMessage(
          { speaker, microphone, mix },
          [speaker.buffer, microphone.buffer, mix.buffer],
        );
        this.speaker = new Float32Array(this.batchSize);
        this.microphone = new Float32Array(this.batchSize);
        this.offset = 0;
      }
    }

    const output = outputs[0];
    if (output) {
      for (const channel of output) {
        channel.fill(0);
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);

export function floatToPcm16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] =
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return output;
}

export function mixMono(
  speaker: Float32Array,
  microphone: Float32Array,
): Float32Array {
  if (speaker.length !== microphone.length) {
    throw new Error("Speaker and microphone buffers must have equal length.");
  }
  const output = new Float32Array(speaker.length);
  for (let index = 0; index < output.length; index += 1) {
    const mixed = ((speaker[index] ?? 0) + (microphone[index] ?? 0)) * 0.5;
    output[index] = Math.max(-1, Math.min(1, mixed));
  }
  return output;
}

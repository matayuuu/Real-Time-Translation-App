declare module "@breezystack/lamejs" {
  export class Mp3Encoder {
    public constructor(channels: number, sampleRate: number, kbps: number);
    public encodeBuffer(samples: Int16Array): Int8Array;
    public flush(): Int8Array;
  }
}

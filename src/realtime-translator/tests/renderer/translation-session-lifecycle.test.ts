import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranslationSessionSecret } from "../../src/shared/contracts";
import { TranslationSession } from "../../src/renderer/src/realtime/translation-session";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send = vi.fn((data: string) => {
    if (data === JSON.stringify({ type: "session.close" })) {
      this.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({ type: "session.closed" }),
      }));
    }
  });

  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakePeerConnection {
  channel = new FakeDataChannel();
  connectionState: RTCPeerConnectionState = "connected";
  ontrack: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "test-offer" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
}

describe("TranslationSession authentication lifecycle", () => {
  const secret: TranslationSessionSecret = {
    value: "test-ephemeral-secret",
    endpoint: "https://aif-test.openai.azure.com",
    expiresAt: 2_000_000_000,
  };
  const createSecret = vi.fn();
  const fetcher = vi.fn<typeof fetch>();
  let peers: FakePeerConnection[];
  let sessions: TranslationSession[];

  function fixture() {
    const audioTrack = { enabled: true } as MediaStreamTrack;
    const callbacks = {
      onState: vi.fn(),
      onTranscript: vi.fn(),
      onFinalize: vi.fn(),
      onError: vi.fn(),
    };
    const session = new TranslationSession("speaker", audioTrack, callbacks);
    sessions.push(session);
    return { session, audioTrack, callbacks };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    peers = [];
    sessions = [];
    createSecret.mockReset().mockResolvedValue(secret);
    fetcher.mockReset().mockImplementation(async () => new Response("test-answer"));
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { translation: { createSecret } },
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("MediaStream", vi.fn(class {}));
    vi.stubGlobal("RTCPeerConnection", vi.fn(class extends FakePeerConnection {
      constructor() {
        super();
        peers.push(this);
      }
    }));
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses a preflight secret without repeating authentication after audio capture", async () => {
    const { session, callbacks } = fixture();
    await session.start(secret);
    expect(createSecret).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(callbacks.onState).toHaveBeenLastCalledWith("connected");
  });

  it("renews a preflight secret if media-device selection outlasts its expiry", async () => {
    const { session } = fixture();
    await session.start({ ...secret, expiresAt: Date.now() / 1_000 - 1 });
    expect(createSecret).toHaveBeenCalledExactlyOnceWith({
      source: "speaker",
      targetLanguage: "ja",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not connect if the session was ended while waiting for authentication", async () => {
    let resolveSecret!: (value: TranslationSessionSecret) => void;
    createSecret.mockImplementationOnce(() => new Promise<TranslationSessionSecret>((resolve) => {
      resolveSecret = resolve;
    }));
    const { session, callbacks, audioTrack } = fixture();
    const starting = session.start();
    const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await session.close();
    resolveSecret(secret);
    await rejected;

    expect(audioTrack.enabled).toBe(false);
    expect(peers).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(callbacks.onState).toHaveBeenLastCalledWith("closed");
  });

  it("does not request another secret when an ended session has a queued reconnect", async () => {
    const { session, callbacks } = fixture();
    await session.start(secret);
    peers[0]!.connectionState = "disconnected";
    peers[0]!.onconnectionstatechange?.();
    await session.close();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(createSecret).not.toHaveBeenCalled();
    expect(peers).toHaveLength(1);
    expect(callbacks.onState).toHaveBeenLastCalledWith("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps audio paused while establishing a replacement connection for RESUME", async () => {
    const { session, audioTrack, callbacks } = fixture();
    await session.start(secret);
    session.pause();
    peers[0]!.channel.readyState = "closed";

    const resuming = session.prepareResume();
    await vi.advanceTimersByTimeAsync(500);
    await resuming;
    expect(audioTrack.enabled).toBe(false);
    expect(peers).toHaveLength(2);
    expect(createSecret).toHaveBeenCalledOnce();
    expect(callbacks.onState).toHaveBeenLastCalledWith("connected");
    session.resume();
    expect(audioTrack.enabled).toBe(true);
  });

  it("does not report connected after closing during SDP negotiation", async () => {
    let requestSignal: AbortSignal | null | undefined;
    fetcher.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal;
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    }));
    const { session, callbacks } = fixture();
    const starting = session.start(secret);
    const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    await session.close();
    await rejected;

    expect(requestSignal?.aborted).toBe(true);
    expect(peers[0]!.setRemoteDescription).not.toHaveBeenCalled();
    expect(callbacks.onState).toHaveBeenLastCalledWith("closed");
  });

  it("cancels data-channel waiting and cleans its timer when the session ends", async () => {
    fetcher.mockImplementationOnce(async () => {
      peers[0]!.channel.readyState = "connecting";
      return new Response("test-answer");
    });
    const { session, callbacks } = fixture();
    const starting = session.start(secret);
    const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(peers[0]!.setRemoteDescription).toHaveBeenCalledOnce();
    await session.close();
    await rejected;

    expect(callbacks.onState).toHaveBeenLastCalledWith("closed");
    expect(vi.getTimerCount()).toBe(0);
  });
});

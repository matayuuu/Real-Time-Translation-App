// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { showSaveDialog } = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
}));
vi.mock("electron", () => ({
  dialog: {
    showSaveDialog,
  },
}));

import { RecordingService } from "../../src/main/recording-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
  showSaveDialog.mockReset();
});

describe("RecordingService", () => {
  it("writes tracks in order and saves a completed MP3", async () => {
    const directory = await mkdtemp(join(tmpdir(), "translator-recording-"));
    temporaryDirectories.push(directory);
    const service = new RecordingService(directory);
    await service.initialize();
    const session = await service.start(48_000);

    await Promise.all([
      service.append({
        sessionId: session.sessionId,
        track: "speaker",
        chunk: new Uint8Array([1, 2]),
      }),
      service.append({
        sessionId: session.sessionId,
        track: "speaker",
        chunk: new Uint8Array([3, 4]),
      }),
    ]);
    const result = await service.stop(session.sessionId);
    expect(result.tracks.speaker.byteLength).toBe(4);

    const savedPath = join(directory, "saved.mp3");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: savedPath });
    await service.save({
      sessionId: session.sessionId,
      track: "speaker",
      suggestedName: "speaker.mp3",
    });
    expect(Array.from(await readFile(savedPath))).toEqual([1, 2, 3, 4]);
    await service.discard(session.sessionId);
    await expect(
      service.save({
        sessionId: session.sessionId,
        track: "speaker",
        suggestedName: "speaker.mp3",
      }),
    ).rejects.toThrow("Unknown recording session");
  });

  it("rejects writes after stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "translator-recording-"));
    temporaryDirectories.push(directory);
    const service = new RecordingService(directory);
    await service.initialize();
    const session = await service.start(48_000);
    await service.stop(session.sessionId);

    await expect(
      service.append({
        sessionId: session.sessionId,
        track: "mix",
        chunk: new Uint8Array([1]),
      }),
    ).rejects.toThrow("already stopped");
  });
});

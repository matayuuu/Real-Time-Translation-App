// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RecordingService } from "../../src/main/recording-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
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
        chunk: new Uint8Array([1, 2]),
      }),
      service.append({
        sessionId: session.sessionId,
        chunk: new Uint8Array([3, 4]),
      }),
    ]);
    const result = await service.stop(session.sessionId);
    expect(result.byteLength).toBe(4);

    const savedPath = join(directory, "saved.mp3");
    await service.copy(session.sessionId, savedPath);
    expect(Array.from(await readFile(savedPath))).toEqual([1, 2, 3, 4]);
    await service.discard(session.sessionId);
    await expect(
      service.copy(session.sessionId, savedPath),
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
        chunk: new Uint8Array([1]),
      }),
    ).rejects.toThrow("already stopped");
  });
});

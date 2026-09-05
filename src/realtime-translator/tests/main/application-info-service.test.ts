// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationInfoService } from "../../src/main/application-info-service";

describe("ApplicationInfoService", () => {
  let directory: string;
  let storagePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "realtime-translator-info-"));
    storagePath = join(directory, "application-info.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps the first launch time while the installed version is unchanged", async () => {
    const firstLaunch = new ApplicationInfoService(
      storagePath,
      "0.1.13",
      () => new Date("2026-09-05T00:45:00.000Z"),
    );
    expect(await firstLaunch.get()).toEqual({
      version: "0.1.13",
      lastUpdatedAt: "2026-09-05T00:45:00.000Z",
    });

    const nextLaunch = new ApplicationInfoService(
      storagePath,
      "0.1.13",
      () => new Date("2026-09-06T00:00:00.000Z"),
    );
    expect(await nextLaunch.get()).toEqual({
      version: "0.1.13",
      lastUpdatedAt: "2026-09-05T00:45:00.000Z",
    });
  });

  it("records a new update time when the installed version changes", async () => {
    await new ApplicationInfoService(
      storagePath,
      "0.1.13",
      () => new Date("2026-09-05T00:45:00.000Z"),
    ).get();

    const updated = new ApplicationInfoService(
      storagePath,
      "0.1.14",
      () => new Date("2026-09-06T01:30:00.000Z"),
    );
    expect(await updated.get()).toEqual({
      version: "0.1.14",
      lastUpdatedAt: "2026-09-06T01:30:00.000Z",
    });
  });

  it("reports invalid persisted information instead of replacing it silently", async () => {
    await writeFile(storagePath, "{not-json", "utf8");

    const service = new ApplicationInfoService(storagePath, "0.1.13");
    await expect(service.get()).rejects.toThrow("is not valid JSON");
  });
});

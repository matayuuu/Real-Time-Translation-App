// @vitest-environment node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const rendererRoot = resolve(import.meta.dirname, "../../src/renderer");

describe("renderer stylesheet loading", () => {
  it("loads styles as a self-hosted stylesheet rather than Vite's inline injection", async () => {
    const [html, entry] = await Promise.all([
      readFile(resolve(rendererRoot, "index.html"), "utf8"),
      readFile(resolve(rendererRoot, "src/main.tsx"), "utf8"),
    ]);

    expect(html).toContain('<link rel="stylesheet" href="/src/styles.css" />');
    expect(entry).not.toMatch(/import\s+["'][^"']+\.css["']/);
    expect(html).toContain("style-src 'self'");
    expect(html).not.toContain("'unsafe-inline'");
    expect(await readFile(resolve(rendererRoot, "src/styles.css"), "utf8"))
      .toContain(".transcript-grid");
  });

  it("keeps inline theme styles authorized by their exact CSP hash", async () => {
    const html = (await readFile(resolve(rendererRoot, "index.html"), "utf8"))
      .replaceAll("\r\n", "\n");
    const theme = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    expect(theme).toBeDefined();
    const digest = createHash("sha256").update(theme!).digest("base64");
    expect(html).toContain(`'sha256-${digest}'`);
  });
});

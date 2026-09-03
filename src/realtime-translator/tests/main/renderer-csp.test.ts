// @vitest-environment node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("renderer content security policy", () => {
  it("allows the inline theme bootstrap by its exact hash", () => {
    const htmlPath = fileURLToPath(
      new URL("../../src/renderer/index.html", import.meta.url),
    );
    const html = readFileSync(htmlPath, "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const csp = html.match(
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
    )?.[1];

    expect(script).toBeDefined();
    expect(csp).toBeDefined();
    const hash = createHash("sha256")
      .update(script!.replaceAll("\r\n", "\n"))
      .digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
  });
});

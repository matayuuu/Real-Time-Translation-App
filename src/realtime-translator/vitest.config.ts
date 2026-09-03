import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": resolve(import.meta.dirname, "src/renderer/src"),
      "@shared": resolve(import.meta.dirname, "src/shared"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});

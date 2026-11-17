import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**"],
    testTimeout: 30_000,
    sequence: { shuffle: true },
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/chain/**"],
      reporter: ["text", "json-summary", "html"],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});

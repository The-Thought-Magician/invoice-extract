import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Playwright suite lives in e2e/ and is run by `test:e2e`.
    include: ["tests/**/*.test.ts"],
    // PGlite starts a WASM Postgres per test; the default 5s is not enough.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

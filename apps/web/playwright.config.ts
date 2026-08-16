import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

// __dirname rather than import.meta.url: Playwright loads this config as CJS.
const repoRoot = resolve(__dirname, "../../") + "/";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // One worker: the suite shares one server and one embedded database, and the
  // duplicate-detection test depends on ordering.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  projects: [
    {
      name: "chromium",
      use: {
        // The sandbox ships Chromium 1194 while this Playwright expects 1234.
        // Point at what is actually installed instead of downloading a second
        // copy. Unset CHROMIUM_PATH to use Playwright's own managed browser.
        launchOptions: process.env.CHROMIUM_PATH
          ? { executablePath: process.env.CHROMIUM_PATH }
          : {},
      },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx next start -p 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // No API key: extraction replays recorded answers so the suite is
      // deterministic and runs offline. Everything downstream of extraction,
      // including real OCR on the scanned fixtures, runs for real.
      RECORDED_RUNS: `${repoRoot}fixtures/recorded-runs.json`,
      SCHEMA_PATH: `${repoRoot}db/schema.sql`,
      STORAGE_DIR: `${repoRoot}apps/web/.e2e-storage`,
      PGLITE_PATH: "memory://invoice-extract-e2e",
      // The gate is open, so routing decisions are actually exercised. In
      // production this defaults to closed until the error rate is measured.
      COLD_START: "false",
      // Deterministic: no invoice is diverted to review by random sampling.
      AUDIT_SAMPLE_RATE: "0",
      EXTRACTION_RUNS: "3",
      OCR_DPI: "300",
    },
  },
});

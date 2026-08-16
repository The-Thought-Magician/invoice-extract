import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { globals: true, include: ["tests/**/*.test.ts"] },
  resolve: {
    alias: {
      "@invoice-extract/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});

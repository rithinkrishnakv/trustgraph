import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000, // some tests hit the live npm registry
    hookTimeout: 20_000,
    fileParallelism: false, // shared SQLite file-per-test isn't needed since we use :memory:, but
    // collectors/tests touching live network are gentler run serially
  },
});

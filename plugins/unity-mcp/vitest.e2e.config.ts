import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["__tests__/e2e/**/*.test.ts"],
    globalSetup: [
      "__tests__/e2e/global-setup.ts",
      "__tests__/e2e/global-teardown.ts",
    ],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    sequence: { concurrent: false },
    fileParallelism: false,
    bail: 1,
    passWithNoTests: false,
  },
});

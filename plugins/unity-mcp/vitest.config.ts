import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    passWithNoTests: true,
    exclude: ["__tests__/e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});

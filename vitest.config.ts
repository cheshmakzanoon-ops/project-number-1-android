import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    clearMocks: true,
    restoreMocks: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/*.test.mjs"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    clearMocks: true,
    restoreMocks: true,
    include: [
      "src/components/RemoteVideoFeed.test.tsx",
      "src/components/CallOverlay.video.test.tsx",
      "src/lib/useCallkit.video.test.tsx",
    ],
  },
});

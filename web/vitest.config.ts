import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "import.meta.env.VITE_BUZZ_COMMUNITIES": JSON.stringify("relay.test"),
  },
  test: { include: ["web/**/*.test.ts"] },
});

import { defineConfig } from "@playwright/test";

const port = process.env.STAGING_PORT ?? "9443";

// Drives the web build on the local staging relay (./staging.sh up first).
export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: `https://buzz.localhost:${port}`,
    ignoreHTTPSErrors: true,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});

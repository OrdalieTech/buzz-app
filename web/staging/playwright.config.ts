import { defineConfig } from "@playwright/test";

// Drives the web build on the local staging relay (./staging.sh up first).
export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: "https://buzz.localhost:9443",
    ignoreHTTPSErrors: true,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});

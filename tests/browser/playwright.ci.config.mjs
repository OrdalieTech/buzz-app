import { defineConfig } from "@playwright/test";
import config from "./playwright.config.mjs";

// Linux WebKit is built without MediaRecorder. Those cases run with the local
// config in the required macOS job; Chromium still records on Linux.
// The documented @local-webkit measurements remain local-only.
export default defineConfig({
  ...config,
  // Only the eight-core functional CI jobs opt into the extra worker.
  workers: Number(process.env.BUZZ_BROWSER_WORKERS || config.workers),
  projects: config.projects.map((project) =>
    project.name === "webkit-measurements"
      ? { ...project, grepInvert: /@local-webkit/ }
      : project.name === "webkit"
        ? {
            ...project,
            grepInvert: /@classic-scrollbars|@media-recorder|@local-only/,
          }
        : project.name === "chromium"
          ? { ...project, grepInvert: /@classic-scrollbars|@local-only/ }
          : project,
  ),
});

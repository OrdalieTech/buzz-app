import { defineConfig } from "@playwright/test";

const measurementFiles = [
  "channel-opening.spec.mjs",
  "profile-roster-scale.spec.mjs",
  "scroll.spec.mjs",
];
// Cases that need a scrollbar that takes space. Headless Chromium passes
// --hide-scrollbars by default and only Linux guarantees classic scrollbars,
// so they run in their own Chromium project and never in the engine projects.
const classicScrollbars = /@classic-scrollbars/;

// On macOS, WebKit trace screenshots leak WindowServer IOSurfaces: each traced
// headless WebKit test leaves about 55 surfaces that are never freed. Near 65,536
// surfaces WindowServer aborts and logs the user out. Local macOS runs therefore
// keep WebKit traces without the screenshot filmstrip. DOM snapshots, logs and
// failure screenshots remain. CI runners are disposable and keep the filmstrip.
// Set BUZZ_WEBKIT_TRACE_SCREENSHOTS=1 for one run to restore it locally.
const leakyWebkitTraceScreenshots =
  process.platform === "darwin" && !process.env.CI;
const webkitTraceScreenshots =
  !leakyWebkitTraceScreenshots ||
  process.env.BUZZ_WEBKIT_TRACE_SCREENSHOTS === "1";
const webkitTrace = {
  mode: "retain-on-failure",
  screenshots: webkitTraceScreenshots,
};
// Workers load this config too; warn once, from the runner process.
if (
  leakyWebkitTraceScreenshots &&
  webkitTraceScreenshots &&
  process.env.TEST_WORKER_INDEX === undefined
) {
  console.warn(
    [
      "",
      "WARNING: BUZZ_WEBKIT_TRACE_SCREENSHOTS=1 enables WebKit trace screenshots on macOS.",
      "This LEAKS WindowServer IOSurfaces (about 55 per WebKit test) that are not freed",
      "until you log out. Near 65,536 surfaces WindowServer crashes and logs you out.",
      "Use it for a single diagnostic run only.",
      "",
    ].join("\n"),
  );
}

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  // Prepares the dependency cache that every Vite fixture server starts from.
  globalSetup: "./vite-server.mjs",
  outputDir: "../../test-results/browser",
  // Functional journeys share two workers; measurements run first and alone.
  // Never hide failures with retries or measure opening under another browser's load.
  workers: 2,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    viewport: { width: 1440, height: 950 },
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-measurements",
      use: { browserName: "chromium" },
      testMatch: measurementFiles,
      workers: 1,
    },
    {
      name: "webkit-measurements",
      use: { browserName: "webkit", trace: webkitTrace },
      testMatch: measurementFiles,
      workers: 1,
      dependencies: ["chromium-measurements"],
    },
    ...["chromium", "webkit"].map((browserName) => ({
      name: browserName,
      use:
        browserName === "webkit"
          ? { browserName, trace: webkitTrace }
          : { browserName },
      testIgnore: measurementFiles,
      grepInvert: classicScrollbars,
      dependencies: ["webkit-measurements"],
    })),
    {
      name: "chromium-classic-scrollbars",
      use: {
        browserName: "chromium",
        launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
      },
      testIgnore: measurementFiles,
      grep: classicScrollbars,
      // CI runs this project as a second Playwright invocation in the
      // measurements job, and every run clears the outputDir of the projects
      // it selects. A separate directory keeps the measurement evidence intact.
      outputDir: "../../test-results/browser-classic-scrollbars",
      // Locally the full gate still runs measurements first and alone.
      dependencies: ["webkit-measurements"],
    },
  ],
});

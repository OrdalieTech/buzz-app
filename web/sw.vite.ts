import { build, type Plugin } from "vite";

// Builds web/sw.ts to /sw.js beside the app: a classic, self-contained script
// at the site root (no module service workers needed), with the app's
// community allowlist.
export function serviceWorker(): Plugin {
  let env: Record<string, unknown> = {};
  let outDir = "";
  return {
    name: "buzz-service-worker",
    apply: "build",
    configResolved(config) {
      env = config.env;
      outDir = config.build.outDir;
    },
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: "warn",
        define: {
          "import.meta.env.VITE_BUZZ_COMMUNITIES": JSON.stringify(
            env.VITE_BUZZ_COMMUNITIES,
          ),
        },
        build: {
          copyPublicDir: false,
          emptyOutDir: false,
          outDir,
          lib: {
            entry: new URL("./sw.ts", import.meta.url).pathname,
            fileName: () => "sw.js",
            formats: ["iife"],
            name: "buzzServiceWorker",
          },
        },
      });
    },
  };
}

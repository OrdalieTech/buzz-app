import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite";
import upstream from "../vite.config.ts";
import { serviceWorker } from "./sw.vite.ts";

// Browser (PWA) build of the unchanged app: the browser host in web/host.ts
// answers the native IPC before src/main.tsx runs, so isTauri() stays false.

// The installed app's name comes from the build's environment.
const name = process.env.VITE_BUZZ_APP_NAME || "Buzz";
const manifest = {
  id: "/",
  name,
  short_name: name,
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f1f1f2",
  theme_color: "#f1f1f2",
  icons: [
    // The artwork sits inside the maskable safe zone on a full-bleed ground.
    {
      src: "/app-icon.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
    { src: "/apple-touch-icon.png", sizes: "256x256", type: "image/png" },
  ],
};

// Welcome.tsx's first-run key pages, replaced by web/onboarding.tsx.
const onboarding: Plugin = {
  name: "buzz-web-onboarding",
  enforce: "pre",
  resolveId: (source, importer) =>
    importer?.endsWith("/src/features/identity/Welcome.tsx") &&
    ["./ConnectChoice", "./KeyImport"].includes(source)
      ? fileURLToPath(new URL("./onboarding.tsx", import.meta.url))
      : null,
};

// A distributor's app icon (VITE_BUZZ_APP_ICON: a square PNG, artwork inside
// the maskable safe zone) replaces upstream's at the paths that use it.
const icon = process.env.VITE_BUZZ_APP_ICON;
let outDir = "";

const browserHost: Plugin = {
  name: "buzz-browser-host",
  configResolved(config) {
    outDir = resolve(config.root, config.build.outDir);
  },
  closeBundle() {
    if (icon)
      for (const name of ["app-icon.png", "apple-touch-icon.png"])
        copyFileSync(icon, resolve(outDir, name));
  },
  // Before Vite's own resolver, so the app's plugin list gains web/orb.tsx.
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "../bundled" && importer?.endsWith("/src/app/services.ts"))
      return fileURLToPath(new URL("./orb.tsx", import.meta.url));
  },
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "manifest.webmanifest",
      source: JSON.stringify(manifest),
    });
  },
  transformIndexHtml: {
    // Before Vite resolves the entry script.
    order: "pre",
    handler: (html) =>
      html
        .replace('src="/src/main.tsx"', 'src="/web/main.ts"')
        .replace(
          'content="width=device-width, initial-scale=1.0"',
          // Android shrinks the layout for the keyboard; iOS: web/mobile.ts.
          'content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"',
        )
        .replace(
          "</head>",
          `  <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="${name}" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  </head>`,
        ),
  },
};

export default defineConfig(async (env) => {
  const { VITE_BUZZ_COMMUNITIES = "" } = loadEnv(
    env.mode,
    process.cwd(),
    "VITE_BUZZ_COMMUNITIES",
  );
  if (!VITE_BUZZ_COMMUNITIES.trim())
    throw new Error(
      'Set VITE_BUZZ_COMMUNITIES to the community hosts this build may join, e.g. "chat.example.com,other.example.com".',
    );
  // Builderlab account sign-in needs the desktop app; empty opts out of the
  // built-in server (federatedBuilderlabUrl in vite.config.ts).
  process.env.BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG = "";
  const config = (await upstream(env)) as UserConfig;
  // The huddle window is native-only.
  const { huddle: _, ...input } = (config.build?.rollupOptions?.input ??
    {}) as Record<string, string>;
  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      browserHost,
      onboarding,
      serviceWorker(),
    ],
    define: {
      ...config.define,
      "import.meta.env.VITE_BUZZ_BROWSER_HOST": JSON.stringify("1"),
    },
    build: {
      ...config.build,
      rollupOptions: { ...config.build?.rollupOptions, input },
      outDir: "dist/web",
    },
  };
});

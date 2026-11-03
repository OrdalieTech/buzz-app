import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite";
import upstream from "../vite.config.ts";

// Browser (PWA) build of the unchanged app: the browser host in web/host.ts
// answers the native IPC before src/main.tsx runs, so isTauri() stays false.

const manifest = {
  name: "Buzz",
  short_name: "Buzz",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f1f1f2",
  theme_color: "#f1f1f2",
  icons: [
    { src: "/app-icon.png", sizes: "512x512", type: "image/png" },
    { src: "/apple-touch-icon.png", sizes: "256x256", type: "image/png" },
  ],
};

const browserHost: Plugin = {
  name: "buzz-browser-host",
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
          'content="width=device-width, initial-scale=1, viewport-fit=cover"',
        )
        .replace(
          "</head>",
          '  <link rel="manifest" href="/manifest.webmanifest" />\n  </head>',
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
  const config = (await upstream(env)) as UserConfig;
  // The huddle window is native-only.
  const { huddle: _, ...input } = (config.build?.rollupOptions?.input ??
    {}) as Record<string, string>;
  return {
    ...config,
    plugins: [...(config.plugins ?? []), browserHost],
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

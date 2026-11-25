import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
// Tests can generate independent artifacts concurrently without racing dist-author.
const out = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}/`)
  : new URL("dist-author/", root);
await rm(out, { recursive: true, force: true });
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "tsc",
    "-p",
    "tsconfig.author.json",
    "--outDir",
    fileURLToPath(new URL("types/", out)),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
await mkdir(out, { recursive: true });
await Promise.all(
  ["LICENSE", "NOTICE.md"].map((file) =>
    copyFile(new URL(file, root), new URL(file, out)),
  ),
);
await writeFile(
  new URL("package.json", out),
  `${JSON.stringify(
    {
      name: "@buzz/author",
      version: "0.0.0-preview.2",
      license: "Apache-2.0",
      private: true,
      type: "module",
      types: "types/plugins/author.d.ts",
      exports: { ".": { types: "./types/plugins/author.d.ts" } },
      dependencies: {
        "@deepseek-ai/cordis": pkg.dependencies["@deepseek-ai/cordis"],
        "@types/react": pkg.devDependencies["@types/react"],
        "nostr-tools": pkg.dependencies["nostr-tools"],
      },
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Generated type-only @buzz/author preview in ${fileURLToPath(out)}; no runtime imports supported.`,
);

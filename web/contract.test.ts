import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { commands, key } from "./commands.ts";
import { keyCommands } from "./keys.ts";
import { unsupported } from "./unsupported.ts";

// Every IPC command the native host registers must be either implemented by
// the browser host or explicitly refused, so each upstream merge that adds
// one fails here instead of in users' hands.
const lib = readFileSync(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
).replace(/#\[[^\]]*\]/g, "");
const registered = new Set(
  [...lib.matchAll(/generate_handler!\[([^\]]*)\]/g)].flatMap(([, body]) =>
    (body ?? "")
      .split(",")
      .map((entry) => entry.trim().split("::").pop() ?? "")
      .filter(Boolean),
  ),
);
const implemented = Object.keys(commands);

test("finds the native command registry", () => {
  expect(registered.size).toBeGreaterThan(150);
});

test("classifies every registered command", () => {
  expect(
    [...registered].filter(
      (command) =>
        !implemented.includes(command) && !unsupported.includes(command),
    ),
  ).toEqual([]);
});

test("has no stale or conflicting entries", () => {
  expect(
    [...implemented, ...unsupported].filter(
      (command) => !registered.has(command),
    ),
  ).toEqual([]);
  expect(
    implemented.filter((command) => unsupported.includes(command)),
  ).toEqual([]);
});

test("keeps the upstream anchors the web build relies on", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  for (const path of [
    "src/features/identity/service.ts",
    "src/features/agents/native.ts",
  ])
    expect(read(path)).toContain(
      'import.meta.env.VITE_BUZZ_BROWSER_HOST === "1"',
    );
  // vite.web.config.ts swaps this import for web/orb.tsx.
  expect(read("src/app/services.ts")).toContain(
    'import { bundledPlugins } from "../bundled";',
  );
  expect(read("src/features/navigation/deep-links.ts")).toContain(
    'import.meta.env.VITE_BUZZ_BROWSER_HOST !== "1"',
  );
  // web/onboarding.tsx replaces these imports, and email sign-in stays hidden.
  const welcome = read("src/features/identity/Welcome.tsx");
  for (const anchor of [
    'from "./ConnectChoice"',
    'from "./KeyImport"',
    'hidden={import.meta.env.VITE_BUZZ_BROWSER_HOST === "1"}',
  ])
    expect(welcome).toContain(anchor);
  const html = read("index.html");
  expect(html).toContain('src="/src/main.tsx"');
  expect(html).toContain('content="width=device-width, initial-scale=1.0"');
});

test("forwards exactly the key Worker's commands", () => {
  const forwarded = implemented.filter((name) => commands[name] === key);
  expect(forwarded.filter((name) => !(name in keyCommands))).toEqual([]);
  expect(
    Object.keys(keyCommands).filter((name) => !(name in commands)),
  ).toEqual([]);
});

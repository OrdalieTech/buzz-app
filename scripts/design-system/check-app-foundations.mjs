#!/usr/bin/env node
/** Keep application UI on the shared foundations, including CSS inside adapters.
 * Layout dimensions, image geometry and terminal ANSI/artwork are not UI tokens.
 * The existing type/color guards separately cover the shared system and viewer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../src", import.meta.url));
const rules = [
  ["literal color", /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/gi],
  ["custom text size", /font-size\s*:(?!\s*(?:var\(|inherit\b))\s*[^;\n]+/g],
  ["custom font weight", /font-weight\s*:\s*\d+/g],
  [
    "custom font family",
    /font-family\s*:(?!\s*(?:var\(|inherit\b))\s*[^;\n]+/g,
  ],
  [
    "stock palette",
    /\b(?:bg|text|border|ring|outline)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00)\b/g,
  ],
  ["mixed surface color", /\b(?:bg|text|border)-[\w-]+\/\d+\b/g],
  [
    "legacy text utility",
    /(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl)\b|\btext-\[[^\]]+\]/g,
  ],
  [
    "custom spacing",
    /(?:^|[;{\n])\s*(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?\s*:[^;{}]*\b\d*\.?\d+(?:px|rem|em)\b/g,
  ],
  [
    "custom corner",
    /border-(?:radius|(?:top|bottom)-(?:left|right)-radius)\s*:\s*[1-9][\d.]*(?:px|rem)/g,
  ],
];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (path.includes("/shared/design-system")) return [];
    if (entry.isDirectory()) return files(path);
    if (!/\.(?:css|tsx|ts)$/.test(path) || /(?:\.test\.|fixture)/.test(path))
      return [];
    return [path];
  });
}

const failures = [];
// Product artwork retains its literal hues. Exceptions name exact files and
// colors; all other values and foundation rules remain checked.
const artworkColors = new Map([
  // Mobile chartreuse welcome and decorative bee artwork retain their exact hues.
  // Controls use the shared semantic roles without local overrides.
  [
    "features/identity/IdentitySetup.module.css",
    new Set(["#d7d72e", "#231e1e", "#d7e7f5", "#dbfa52"]),
  ],
  [
    "features/profiles/AvatarCustomColor.module.css",
    new Set(["#000", "#fff", "#f00", "#ff0", "#0f0", "#0ff", "#00f", "#f0f"]),
  ],
  [
    "features/profiles/AvatarEditor.module.css",
    new Set(["#ff4d4d", "#ffe75c", "#73ef75", "#63c6f2", "#b141ff"]),
  ],
]);
for (const path of files(root)) {
  // Ignore comments without changing reported line numbers. Plain TS is included
  // because Emoji Mart's shadow-root stylesheet lives in its adapter module.
  const source = readFileSync(path, "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    (comment) => comment.replace(/[^\n]/g, " "),
  );
  for (const [rule, pattern] of rules) {
    for (const match of source.matchAll(pattern)) {
      if (
        rule === "literal color" &&
        artworkColors.get(relative(root, path))?.has(match[0])
      )
        continue;
      // The host root applies the saved interface scale once to every rem role.
      if (
        rule === "custom text size" &&
        relative(root, path) === "shared/styles/globals.css" &&
        match[0] === "font-size: calc(100% * var(--buzz-text-scale, 1))"
      )
        continue;
      // Non-CSS strings can contain event IDs, channel hashtags or selector IDs.
      if (
        rule === "literal color" &&
        !path.endsWith(".css") &&
        !/[:[]\s*$/.test(
          source.slice(Math.max(0, match.index - 4), match.index),
        )
      )
        continue;
      const line = source.slice(0, match.index).split("\n").length;
      failures.push(
        `${relative(root, path)}:${line}: ${rule}: ${match[0].trim()}`,
      );
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "✓ App foundations: no private colors, text sizes, spacing or corners",
  );
}

import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

// Immutable build/server per worker; each test owns its page and fixture state.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-model-picker-row-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/model-picker-row.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/model-picker-row.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Layout: the Model row spans its Settings group like the rows beside it, so
// its trigger ends at the row's trailing edge instead of shrinking mid-row.
test("a Model preference row aligns its trigger with sibling rows", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(url);
  const model = page.getByRole("combobox", { name: "Model" });
  const thinking = page.getByRole("combobox", { name: "Thinking" });
  await expect(model).toBeVisible();
  await expect(thinking).toBeVisible();
  const edges = (button) =>
    button.evaluate((element) => {
      const row = element.closest(".buzz-preference-row");
      const value = element.querySelector(".buzz-select-value");
      return {
        rowLeft: Math.round(row.getBoundingClientRect().left),
        rowRight: Math.round(row.getBoundingClientRect().right),
        right: Math.round(element.getBoundingClientRect().right),
        truncated: value.scrollWidth > value.clientWidth,
      };
    });
  const [modelEdges, thinkingEdges] = await Promise.all([
    edges(model),
    edges(thinking),
  ]);
  expect(modelEdges).toEqual({ ...thinkingEdges, truncated: false });
  expect(modelEdges.right).toBe(modelEdges.rowRight);
  expect(errors.unexplained()).toEqual([]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../../public/onboarding-intro-init.js", import.meta.url),
  "utf8",
);
function bootstrap({
  seen = false,
  reduced = false,
  storageFails = false,
  native = true,
} = {}) {
  const calls = [];
  const timers = [];
  const dataset = {};
  runInNewContext(source, {
    window: {
      __TAURI_INTERNALS__: native
        ? { invoke: async (command) => calls.push(command) }
        : undefined,
    },
    navigator: { platform: "MacIntel" },
    document: { documentElement: { dataset } },
    localStorage: {
      getItem: () => {
        if (storageFails) throw new Error("Unavailable");
        return seen ? "seen" : null;
      },
    },
    matchMedia: () => ({ matches: reduced }),
    setTimeout: (callback) => timers.push(callback),
  });
  return { calls, timers, dataset };
}
test("fresh native launch stays hidden until the intro prepares it", () => {
  const state = bootstrap();
  assert.equal(state.dataset.welcomeIntro, "pending");
  assert.deepEqual(state.calls, []);
  state.dataset.welcomeIntro = "running";
  state.timers[0]();
  assert.deepEqual(state.calls, []);
});
test("failed bootstrap exposes the normal launch surface", () => {
  const state = bootstrap();
  state.timers[0]();
  assert.equal(state.dataset.welcomeIntro, undefined);
  assert.deepEqual(state.calls, ["plugin:window|show"]);
});
for (const options of [
  { seen: true },
  { reduced: true },
  { storageFails: true },
]) {
  test(`normal launch remains visible: ${JSON.stringify(options)}`, () => {
    const state = bootstrap(options);
    assert.deepEqual(state.calls, ["plugin:window|show"]);
    assert.equal(state.dataset.welcomeIntro, undefined);
  });
}
test("browser launch does not invoke native window commands", () => {
  assert.deepEqual(bootstrap({ native: false }).calls, []);
});

import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import {
  type NoticeContent,
  NoticesService,
  type ShownNotice,
} from "./service";

const ask: NoticeContent = {
  title: "Publish the draft?",
  description: "Ampy wants to publish it.",
  actions: [
    { id: "yes", label: "Publish", prominent: true },
    { id: "no", label: "Not now" },
  ],
};

async function setup() {
  const root = new Context();
  const notices = new NoticesService(root);
  let plugin!: Context;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx: Context) => {
      plugin = ctx;
    });
  await fiber.await();
  const show = (
    content: NoticeContent = ask,
    options?: { signal?: AbortSignal },
  ) => {
    const shown = plugin.reflect.get("notices")?.show(content, options);
    if (!shown) throw new Error("no notices service");
    return shown;
  };
  return { root, notices, fiber, show };
}

it("shows a plugin's notice, named for it, until the person picks one of its actions", async () => {
  const { root, notices, show } = await setup();
  const closed = show();
  expect(notices.snapshot()).toMatchObject([
    { ...ask, plugin: "example.plugin" },
  ]);
  const [shown] = notices.snapshot();
  shown?.pick("missing");
  expect(notices.snapshot()).toHaveLength(1);
  shown?.pick("yes");
  await expect(closed).resolves.toBe("yes");
  expect(notices.snapshot()).toEqual([]);
  shown?.pick("no");
  expect(notices.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it.each([
  ["the person dismisses it", (n: Shown) => n.entry.dismiss()],
  ["its signal aborts", (n: Shown) => n.controller.abort()],
  ["the plugin's scope ends", (n: Shown) => n.fiber.dispose()],
])(
  "closes without an answer when %s, and ignores a later pick",
  async (_, close) => {
    const { root, notices, fiber, show } = await setup();
    const controller = new AbortController();
    const closed = show(ask, { signal: controller.signal });
    const entry = notices.snapshot()[0];
    if (!entry) throw new Error("not shown");
    await close({ controller, fiber, entry });
    entry.pick("yes");
    await expect(closed).resolves.toBeUndefined();
    expect(notices.snapshot()).toEqual([]);
    await root.fiber.dispose();
  },
);
type Shown = Readonly<{
  controller: AbortController;
  fiber: ReturnType<Context["plugin"]>;
  entry: ShownNotice;
}>;

it("never shows a notice whose signal already aborted, or one from an ended plugin", async () => {
  const { root, notices, fiber, show } = await setup();
  await expect(
    show(ask, { signal: AbortSignal.abort() }),
  ).resolves.toBeUndefined();
  expect(notices.snapshot()).toEqual([]);
  await fiber.dispose();
  await expect(show()).rejects.toThrow();
  expect(notices.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("refuses a notice without a title, an anonymous caller and more than three actions", async () => {
  const { root, notices, show } = await setup();
  const action = (id: string) => ({ id, label: id });
  for (const bad of [
    { title: " " },
    { title: "T", actions: ["a", "b", "c", "d"].map(action) },
    { title: "T", actions: [action("a"), action("a")] },
    { title: "T", actions: [{ id: "a", label: "" }] },
  ])
    await expect(show(bad)).rejects.toThrow("A notice needs a title");
  await expect(notices.show(ask)).rejects.toThrow(
    "Notices must be shown by an installed plugin",
  );
  expect(notices.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

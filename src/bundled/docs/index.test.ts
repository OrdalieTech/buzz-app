import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { ConversationService } from "../../features/conversation/service";
import { AgentsService } from "../../features/agents/service";
import {
  fakeCommunities,
  fakeRelay,
  fakeNative,
} from "../../features/agents/service-testing";
import { memoryStorage } from "../../features/agents/test-fakes";
import { addedKey, sessionTools } from "../../buzz-mcp/session-tools";
import { apply, inject } from ".";
import { provideNavigation } from "../../features/navigation/service";
import { PanelsService } from "../../features/panels/service";
import { PagesService } from "../../features/pages/service";
import { docsFixture } from "./testing";

it("owns only channel-backed doc routes, tools and panels while preserving separate built-in tools", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    fakeNative(),
    memoryStorage(),
  );
  new ConversationService(ctx);
  const pages = new PagesService(ctx);
  const panels = new PanelsService(ctx);
  provideNavigation(ctx, undefined);
  const active = fakeRelay();
  ctx.provide("relay", active.relay);
  let scope: ReturnType<Context["plugin"]> | undefined;
  try {
    const before = addedKey(service.tools());
    const builtins = sessionTools(service.tools()).map((tool) => tool.name);
    expect(builtins).toEqual(
      expect.arrayContaining(["notes_get", "notes_set", "notes_rm"]),
    );
    expect(builtins.includes("note")).toBe(false);
    scope = ctx
      .extend({
        pluginOwner: { id: "com.squareup.docs", revision: "bundled" },
      })
      .plugin({ inject, apply });
    await scope;
    const added = service.tools().map((tool) => tool.name);
    expect(added).toEqual([
      "doc_help",
      "doc_get",
      "doc_set",
      "doc_history",
      "doc_delete",
    ]);
    const background = await docsFixture();
    try {
      const doc = background.seed(
        "Background community doc",
        "Read as the agent",
      );
      const connection = vi.spyOn(service, "relay").mockReturnValue({
        snapshot: () => ({
          status: "ready",
          generation: 1,
          origin: background.origin,
          session: background.session,
        }),
        subscribe: () => () => {},
        retry() {},
        tryAgain() {},
        disconnect() {},
        clearCache: async () => {},
      });
      const get = service.tools().find((tool) => tool.name === "doc_get");
      if (!get) throw new Error("Missing doc_get");
      const client = background.client();
      const result = JSON.parse((await get.call(client, {}, doc)) as string);
      expect(result.markdown).toBe("Read as the agent");
      expect(connection).toHaveBeenCalledWith(client.key);
      const set = service.tools().find((tool) => tool.name === "doc_set");
      if (!set) throw new Error("Missing doc_set");
      const create = (switchOrClose: () => void) =>
        set.call(
          {
            ...client,
            publish: async (template) => {
              switchOrClose();
              return client.publish(template);
            },
          },
          {},
          {
            id: crypto.randomUUID(),
            title: "Agent doc",
            text: "Created in the background",
          },
        );
      await expect(create(() => active.connect(false))).resolves.toContain(
        "Created in the background",
      );
      await expect(create(background.dispose)).rejects.toThrow(/not confirmed/);
      connection.mockRestore();
    } finally {
      background.dispose();
    }
    expect(pages.snapshot()).toMatchObject([
      {
        id: "docs",
        title: "Docs",
        layout: "workspace",
        primary: true,
        placement: "dock",
      },
    ]);
    const validate = pages.snapshot()[0]?.route?.validate;
    expect(validate?.({ view: "browse" })).toBe(true);
    expect(
      validate?.({
        view: "doc",
        id: "11111111-1111-4111-8111-111111111111",
        channel: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(true);
    expect(
      validate?.({
        author: "c".repeat(64),
        note: `30023:${"c".repeat(64)}:recipe`,
      }),
    ).toBe(false);
    expect(
      validate?.({ view: "shared", shared: `30023:${"c".repeat(64)}:recipe` }),
    ).toBe(false);
    expect(panels.snapshot()).toMatchObject([
      {
        id: "doc",
        addressable: true,
        keepOpen: true,
        channelPlacement: "tab",
      },
    ]);
    expect(addedKey(service.tools())).not.toBe(before);
    expect(sessionTools(service.tools()).map((tool) => tool.name)).toEqual([
      ...builtins,
      ...added,
    ]);
    await scope.dispose();
    expect(service.tools()).toEqual([]);
    expect(pages.snapshot()).toEqual([]);
    expect(panels.snapshot()).toEqual([]);
    expect(addedKey(service.tools())).toBe(before);
    expect(sessionTools(service.tools()).map((tool) => tool.name)).toEqual(
      builtins,
    );
  } finally {
    await scope?.dispose();
    await ctx.fiber.dispose();
  }
});

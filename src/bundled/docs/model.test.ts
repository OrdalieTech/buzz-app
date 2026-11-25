import { fromMarkdown } from "mdast-util-from-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signed } from "../../features/relay/testing";
import {
  DocConflict,
  docTag,
  docTemplate,
  docUrl,
  parseDoc,
  parseDocUrl,
  readDoc,
  readDocHistory,
  saveDoc,
} from "./model";
import { createDocsWorkspace, readDocsPage } from "./workspace";
import { docTools } from "./tools";
import { docsFixture } from "./testing";
import {
  buzzLinkTarget,
  parseBuzzLink,
} from "../../features/navigation/buzz-links";
import { deepLinkStep } from "../../features/navigation/deep-links";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
async function fixture() {
  const f = await docsFixture();
  cleanup.push(f.dispose);
  const workspace = createDocsWorkspace(f.session);
  cleanup.push(workspace.dispose);
  const tools = docTools(() => workspace);
  return {
    ...f,
    workspace,
    tool(name: string) {
      const tool = tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Missing ${name}`);
      return tool;
    },
  };
}

describe("connected doc revisions", () => {
  it.each([false, true])(
    "preserves the conversation anchor through the doc lifecycle (anchored=%s)",
    async (anchored) => {
      const f = await fixture();
      let original = f.seed("Plan", "Original");
      let root: string | undefined;
      if (anchored) {
        const anchor = signed(f.viewer, {
          kind: 9,
          tags: [["h", original.channel]],
          content: "Conversation anchor",
        });
        root = anchor.id;
        f.accepted.push(anchor);
        const event = signed(f.viewer, {
          ...original.event,
          tags: [...original.event.tags.map((tag) => [...tag]), ["root", root]],
        });
        const doc = parseDoc(event);
        if (!doc) throw new Error("Expected anchored doc");
        original = doc;
        f.heads.set(doc.id, event);
        f.revisions.splice(0, 1, event);
        // Losing an unchanged anchor later must not prevent editing the doc.
        f.accepted.splice(f.accepted.indexOf(anchor), 1);
      }
      const updated = await f.workspace.save(original, {
        title: "Plan",
        markdown: "Human edit",
      });
      await f.edit(f.carl, updated, { title: "Plan", markdown: "Agent edit" });
      const current = await readDoc(f.workspace.read, original);
      const deleted = await f.workspace.save(
        current,
        { title: "Plan", markdown: "" },
        "delete",
      );
      const restored = await f.workspace.save(
        deleted,
        { title: "Plan", markdown: original.markdown, restoreFrom: original },
        "restore",
      );
      expect(restored.markdown).toBe("Original");
      expect(f.revisions).toHaveLength(5);
      for (const event of f.revisions) expect(docTag(event, "root")).toBe(root);
      for (const [index, event] of f.revisions.entries())
        expect(docTag(event, "prev")).toBe(f.revisions[index - 1]?.id);
    },
  );
  it("rejects an artifact revision used as a conversation anchor without advancing the head", async () => {
    const f = await fixture(),
      original = f.seed("Plan", "Original");
    f.accepted.push(
      signed(f.viewer, {
        ...original.event,
        tags: original.event.tags.map((tag) => [...tag]),
      }),
    );
    const template = docTemplate(
      original,
      { title: "Plan", markdown: "Edit" },
      original,
    );
    await expect(
      f.client(f.viewer).publish({
        ...template,
        tags: [
          ...template.tags.filter(([key]) => key !== "root"),
          ["root", original.revision],
        ],
      }),
    ).rejects.toThrow("root must be an existing conversation anchor in home");
    expect(f.heads.get(original.id)?.id).toBe(original.revision);
    expect(f.revisions).toHaveLength(1);
  });
  it("reports a competing save accepted between preflight and publication", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Original");
    await expect(
      saveDoc(
        f.workspace.read,
        async (template) => {
          await f.edit(f.carl, doc, {
            title: "Plan",
            markdown: "Concurrent change",
          });
          return f.client(f.viewer).publish(template);
        },
        doc,
        { title: "Plan", markdown: "My draft" },
      ),
    ).rejects.toBeInstanceOf(DocConflict);
    expect(f.heads.get(doc.id)?.content).toBe("Concurrent change");
  });
  it("detects a second writer without publishing the first writer’s stale draft", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "First version");
    const newer = await f.edit(f.carl, doc, {
      title: "Plan",
      markdown: "Carl’s change",
    });
    await expect(
      f.workspace.save(doc, { title: "Plan", markdown: "Unsaved local work" }),
    ).rejects.toBeInstanceOf(DocConflict);
    expect(f.heads.get(doc.id)?.id).toBe(newer.id);
    expect(f.revisions).toHaveLength(2);
  });
  it("keeps the accepted head when its timestamp is older than a retained revision", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Original");
    const current = signed(f.carl, {
      ...docTemplate(doc, { title: "Plan", markdown: "Accepted later" }, doc),
      tags: docTemplate(
        doc,
        { title: "Plan", markdown: "Accepted later" },
        doc,
      ).tags.map((tag) => [...tag]),
      created_at: 1,
    });
    f.heads.set(doc.id, current);
    f.revisions.push(current);
    expect((await readDoc(f.workspace.read, doc)).markdown).toBe(
      "Accepted later",
    );
    expect(
      (await readDocHistory(f.workspace.read, doc)).revisions.map(
        (item) => item.markdown,
      ),
    ).toEqual(["Accepted later", "Original"]);
  });
  it("preserves unfamiliar annotations and refuses unknown doc versions", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Original");
    const annotated = {
      ...doc,
      event: {
        ...doc.event,
        tags: [...doc.event.tags, ["custom", "keep", "all fields"]],
      },
    };
    expect(
      docTemplate(doc, { title: "Renamed", markdown: "Edit" }, annotated).tags,
    ).toContainEqual(["custom", "keep", "all fields"]);
    const tombstone = parseDoc({
      ...doc.event,
      ...docTemplate(doc, { title: doc.title, markdown: "" }, doc, "delete"),
    });
    if (!tombstone) throw new Error("Expected deletion head");
    expect(
      docTemplate(
        doc,
        { title: "Plan", markdown: "Restored", restoreFrom: annotated },
        tombstone,
        "restore",
      ).tags,
    ).toContainEqual(["custom", "keep", "all fields"]);
    const future = parseDoc({
      ...doc.event,
      tags: doc.event.tags.map((tag) =>
        tag[0] === "doc" ? ["doc", "2"] : tag,
      ),
    });
    expect(future?.editable).toBe(false);
    if (!future) throw new Error("Expected readable future doc");
    expect(() =>
      docTemplate(future, { title: "Plan", markdown: "Edit" }, future),
    ).toThrow(/unsupported/);
  });
  it("deletes with an envelope-only tombstone and restores against that exact head", async () => {
    const f = await fixture(),
      original = f.seed("Plan", "Keep history");
    const deleted = await f.workspace.save(
      original,
      { title: "Plan", markdown: "" },
      "delete",
    );
    expect(deleted.deleted).toBe(true);
    expect(deleted.event.content).toBe("");
    expect(
      deleted.event.tags.some(([tag]) =>
        ["title", "doc", "custom"].includes(tag ?? ""),
      ),
    ).toBe(false);
    const listed = await f.workspace.list();
    expect(listed.docs).toMatchObject([{ id: original.id, deleted: true }]);
    const get = f.tool("doc_get");
    for (const args of [{}, { q: "Deleted" }])
      expect(
        JSON.parse((await get.call(f.client(), {}, args)) as string).docs,
      ).toEqual([]);
    expect(
      JSON.parse((await get.call(f.client(), {}, original)) as string).deleted,
    ).toBe(true);
    const restored = await f.workspace.save(
      deleted,
      { title: "Plan", markdown: original.markdown },
      "restore",
    );
    expect(restored.markdown).toBe("Keep history");
    expect(restored.event.tags).toContainEqual(["prev", deleted.revision]);
    expect((await f.workspace.history(original)).revisions).toHaveLength(3);
  });
  it("requires read and write permission for current content and retained history", async () => {
    const f = await fixture(),
      doc = f.seed("Private plan", "Private", false);
    const outsider = (filters: Parameters<typeof f.workspace.read>[0]) =>
      f.client(f.sam).query(filters);
    await expect(readDoc(outsider, doc)).rejects.toThrow(/unavailable/);
    expect((await readDocHistory(outsider, doc)).revisions).toEqual([]);
    await f.workspace.setMember(doc, f.sam.pubkey, "read");
    expect((await readDoc(outsider, doc)).markdown).toBe("Private");
    expect((await readDocHistory(outsider, doc)).revisions).toHaveLength(1);
    await expect(
      saveDoc(outsider, (template) => f.client(f.sam).publish(template), doc, {
        title: "Plan",
        markdown: "No",
      }),
    ).rejects.toThrow(/denied/);
    await f.workspace.setMember(doc, f.sam.pubkey, "remove");
    await expect(readDoc(outsider, doc)).rejects.toThrow(/unavailable/);
  });
});

describe("channel orchestration", () => {
  it("verifies only the creating agent and rejects an unattested creator before allocating storage", async () => {
    const f = await fixture();
    f.profiles.push(
      signed(f.carl, {
        kind: 0,
        content: "{}",
        tags: [],
        created_at: 2_000_000_000,
      }),
    );
    const set = f.tool("doc_set");
    const doc = JSON.parse(
      (await set.call(
        f.client(f.ned),
        {},
        {
          id: crypto.randomUUID(),
          title: "Plan",
          text: "Work",
        },
      )) as string,
    );
    expect(f.channels.get(doc.channel)?.roles).toEqual({
      [f.viewer.pubkey]: "owner",
      [f.ned.pubkey]: "bot",
    });
    const before = f.channels.size;
    await expect(
      set.call(
        f.client(),
        {},
        {
          id: crypto.randomUUID(),
          title: "No",
          text: "Work",
        },
      ),
    ).rejects.toThrow(/ownership could not be verified/);
    expect(f.channels.size).toBe(before);
  });
  it("does not regrant revoked agent access on reads", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Selected access");
    await f.workspace.resolve(doc);
    const channel = f.channels.get(doc.channel);
    if (!channel) throw new Error("Missing channel");
    delete channel.roles[f.ned.pubkey];
    channel.updated++;
    const get = f.tool("doc_get");
    await expect(get.call(f.client(f.ned), {}, doc)).rejects.toThrow(
      /unavailable/,
    );
    expect(channel.roles[f.ned.pubkey]).toBeUndefined();
    expect(f.accepted.filter((event) => event.kind === 9000)).toEqual([]);
  });
  it("refuses sharing a channel that also contains another doc’s deletion head", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Private", false),
      other = f.seed("Other", "Unrelated", false);
    const tombstone = signed(f.viewer, {
      ...docTemplate(
        other,
        { title: other.title, markdown: "" },
        other,
        "delete",
      ),
      tags: docTemplate(
        other,
        { title: other.title, markdown: "" },
        other,
        "delete",
      ).tags.map((tag) => (tag[0] === "h" ? ["h", doc.channel] : [...tag])),
    });
    f.heads.set(other.id, tombstone);
    await expect(
      f.workspace.setMember(doc, f.sam.pubkey, "read"),
    ).rejects.toThrow(/other docs/);
    const channel = f.channels.get(doc.channel);
    if (!channel) throw new Error("Missing channel");
    expect(channel.roles[f.sam.pubkey]).toBeUndefined();
  });
  it("refuses creation recovery in storage already containing another doc", async () => {
    const f = await fixture(),
      doc = f.seed("Existing", "Private", false),
      id = crypto.randomUUID();
    const channel = f.channels.get(doc.channel);
    if (!channel) throw new Error("Missing channel");
    channel.labels = ["buzz.docs", `buzz.docs.${id}`];
    channel.updated++;
    await expect(
      f.tool("doc_set").call(
        f.client(),
        {},
        {
          id,
          title: "New",
          text: "Draft",
        },
      ),
    ).rejects.toThrow(/another doc/);
    expect(channel.roles[f.carl.pubkey]).toBeUndefined();
    expect(f.accepted.filter((event) => event.kind === 9000)).toEqual([]);
  });
  it("checks the creating agent's current read access on every recovery", async () => {
    const f = await fixture();
    const doc = f.seed("Private title", "Private draft", false);
    const args = { id: doc.id, title: doc.title, text: doc.markdown };
    const set = f.tool("doc_set");
    const client = f.client();
    for (const text of [doc.markdown, "New draft"]) {
      await expect(set.call(client, {}, { ...args, text })).rejects.toThrow(
        /^This doc is unavailable or you no longer have access\.$/,
      );
    }
    expect(f.accepted.filter((event) => event.kind === 9000)).toEqual([]);

    const channel = f.channels.get(doc.channel);
    if (!channel) throw new Error("Missing channel");
    channel.roles[f.carl.pubkey] = "guest";
    channel.updated++;
    await expect(set.call(client, {}, args)).resolves.toContain(
      "Private draft",
    );
    await expect(
      set.call(client, {}, { ...args, text: "New draft" }),
    ).rejects.toThrow(/Current doc:.*Private draft/);
  });

  it("resumes an empty storage channel and confirms the revision as the creating agent", async () => {
    const f = await fixture();
    const args = { id: crypto.randomUUID(), title: "Plan", text: "Draft" };
    const set = f.tool("doc_set");
    f.failNextArtifact();
    await expect(set.call(f.client(), {}, args)).rejects.toThrow(
      /Reuse doc ID/,
    );
    expect(f.heads.size).toBe(0);
    const channel = [...f.channels.values()][0];
    if (!channel) throw new Error("Missing channel");
    await expect(set.call(f.client(), {}, args)).resolves.toContain("Draft");
    expect(f.channels.size).toBe(1);
    expect(channel.roles[f.carl.pubkey]).toBe("bot");
    expect(f.heads.get(args.id)?.pubkey).toBe(f.carl.pubkey);
  });

  it("refuses creation before allocating storage on an unsupported connection", async () => {
    const f = await fixture();
    const unsupported = createDocsWorkspace({
      ...f.session,
      configArtifactWriter: undefined,
    });
    cleanup.push(unsupported.dispose);
    await expect(
      unsupported.create({
        id: crypto.randomUUID(),
        title: "Plan",
        markdown: "Work",
      }),
    ).rejects.toThrow(/does not advertise/);
    expect(f.channels.size).toBe(0);
  });
  it("preserves existing memberships when discovery runs after the agent inventory changes", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Shared work");
    const channel = f.channels.get(doc.channel);
    if (!channel) throw new Error("Missing channel");
    const roles = { ...channel.roles };
    f.setAgentKeys([]);
    const listed = await f.workspace.list();
    expect(listed.docs).toContainEqual(expect.objectContaining({ id: doc.id }));
    await f.workspace.open(doc);
    expect(channel.roles).toEqual(roles);
    expect(
      f.accepted.filter((event) => [9000, 9001, 9002].includes(event.kind)),
    ).toEqual([]);
  });
  it("rejects a cursor that could overwrite the discovery identity filter", async () => {
    const read = vi.fn(async () => []);
    await expect(
      readDocsPage(read, "a".repeat(64), "b".repeat(64), {
        until: 1,
        before_id: "c".repeat(64),
        authors: ["d".repeat(64)],
      } as Parameters<typeof readDocsPage>[3]),
    ).rejects.toThrow(/cursor/);
    expect(read).not.toHaveBeenCalled();
  });
  it("creates a private human-only system channel without requiring the agent inventory", async () => {
    const f = await fixture();
    f.unavailableInventory();
    const doc = await f.workspace.create({
      id: crypto.randomUUID(),
      title: "Agent plan",
      markdown: "Shared work",
    });
    const channel = f.channels.get(doc.channel);
    expect(channel?.type).toBe("system");
    expect(channel?.roles).toEqual({
      [f.viewer.pubkey]: "owner",
    });
    expect(
      f.accepted.find((event) => event.kind === 9007)?.tags,
    ).toContainEqual(["visibility", "private"]);
    expect(channel?.labels).not.toContain("buzz.docs.agents");
    expect(f.accepted.filter((event) => event.kind === 9000)).toEqual([]);
  });
  it.each(["refused", "lost receipt"])(
    "recovers a %s first revision using the same doc and channel",
    async (failure) => {
      const f = await fixture();
      const draft = {
        id: crypto.randomUUID(),
        title: "Plan",
        markdown: "Work",
      };
      if (failure === "refused") f.failNextArtifact();
      else f.loseNextReceipt();
      await expect(f.workspace.create(draft)).rejects.toThrow(
        failure === "refused" ? /Reuse doc ID/ : /not confirmed/,
      );
      expect(f.channels.size).toBe(1);
      expect(f.revisions).toHaveLength(failure === "refused" ? 0 : 1);
      expect(await f.workspace.create(draft)).toMatchObject({
        id: draft.id,
        markdown: "Work",
      });
      expect(f.channels.size).toBe(1);
      expect(f.revisions).toHaveLength(1);
    },
  );
  it("adds a reader as guest in one operation, with no intervening edit grant", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Work", false);
    await f.workspace.setMember(doc, f.sam.pubkey, "read");
    const invitations = f.accepted.filter((event) => event.kind === 9000);
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.tags).toContainEqual(["role", "guest"]);
    expect(f.channels.get(doc.channel)?.roles[f.sam.pubkey]).toBe("guest");
  });
  it("keeps role confirmations current and supports explicit administrators", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Work", false);
    await f.workspace.setMember(doc, f.sam.pubkey, "admin", undefined, {
      expectedRole: "absent",
    });
    expect(f.channels.get(doc.channel)?.roles[f.sam.pubkey]).toBe("admin");
    const before = f.accepted.length;
    await expect(
      f.workspace.setMember(doc, f.sam.pubkey, "read", undefined, {
        expectedRole: "member",
      }),
    ).rejects.toThrow(/access changed/);
    expect(f.accepted).toHaveLength(before);
    await f.workspace.setMember(doc, f.sam.pubkey, "read", undefined, {
      expectedRole: "admin",
    });
    expect(f.channels.get(doc.channel)?.roles[f.sam.pubkey]).toBe("guest");
  });
  it("confirms participating agent access when the relay stores the bot role", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Work", false);
    const state = await f.workspace.setMember(doc, f.carl.pubkey, "edit");
    expect(state.roles[f.carl.pubkey]).toBe("bot");
  });
  it("keeps doc access administration unavailable to an editor", async () => {
    const f = await fixture(),
      doc = f.seed("Plan", "Work", false);
    const channel = f.channels.get(doc.channel);
    if (!channel) throw new Error("Missing doc channel");
    channel.roles[f.viewer.pubkey] = "member";
    channel.updated++;
    await expect(
      f.workspace.setMember(doc, f.sam.pubkey, "admin"),
    ).rejects.toThrow(/cannot change/);
    expect(channel.roles[f.sam.pubkey]).toBeUndefined();
  });
  it("keeps deliberate restrictions when a new owned agent asks for access", async () => {
    const f = await fixture(),
      restricted = f.seed("Restricted", "Only owner", false);
    const get = f.tool("doc_get");
    await expect(get.call(f.client(), {}, restricted)).rejects.toThrow(
      /unavailable/,
    );
    expect(
      f.channels.get(restricted.channel)?.roles[f.carl.pubkey],
    ).toBeUndefined();
  });
  it("pages system-channel discovery without claiming a capped result is complete", async () => {
    const f = await fixture();
    for (let index = 0; index < 101; index++)
      f.seed(`Plan ${index}`, "Text", false);
    const page = await f.workspace.list();
    expect(page.docs).toHaveLength(100);
    expect(page.more).toBe(true);
    const next = await f.workspace.list(page.cursor);
    expect(next.docs).toHaveLength(1);
    expect(next.more).toBe(false);
    expect(
      new Set([...page.docs, ...next.docs].map((doc) => doc.id)).size,
    ).toBe(101);
  });
});

it("runs the human–agent editing loop on the same records with caller-authored writes", async () => {
  const f = await fixture();
  const set = f.tool("doc_set"),
    get = f.tool("doc_get");
  const first = JSON.parse(
    (await set.call(
      f.client(),
      {},
      { id: crypto.randomUUID(), title: "Plan", text: "Carl’s plan" },
    )) as string,
  );
  expect(first.message).toBe(`[Plan](<${first.link}>)`);
  const opened = await f.workspace.open(first);
  expect(opened.event.pubkey).toBe(f.carl.pubkey);
  const human = await f.workspace.save(opened, {
    title: "Plan",
    markdown: "Taylor’s changes",
  });
  f.seed("Other reference", "Unrelated content");
  f.seed("Plan private", "Not shared with this agent", false);
  const found = JSON.parse(
    (await get.call(f.client(), {}, { q: "PLAN" })) as string,
  );
  expect(found.docs).toMatchObject([{ id: first.id, title: "Plan" }]);
  expect(found.docs).toHaveLength(1);
  const agentRead = JSON.parse(
    (await get.call(f.client(), {}, { url: found.docs[0].link })) as string,
  );
  expect(agentRead.revision).toBe(human.revision);
  expect(agentRead.markdown).toBe("Taylor’s changes");
  await set.call(
    f.client(),
    {},
    {
      ...first,
      revision: human.revision,
      title: "Plan",
      text: "Carl’s update",
    },
  );
  await expect(get.call(f.client(f.ned), {}, first)).rejects.toThrow(
    /unavailable/,
  );
  await f.workspace.setMember(first, f.ned.pubkey, "edit");
  const other = JSON.parse(
    (await get.call(f.client(f.ned), {}, first)) as string,
  );
  expect(other.markdown).toBe("Carl’s update");
  expect(f.heads.get(first.id)?.pubkey).toBe(f.carl.pubkey);
  expect(
    f.revisions.filter((event) => docTag(event, "d") === first.id),
  ).toHaveLength(3);
  const saved = JSON.parse(
    (await get.call(f.client(), {}, { url: first.link })) as string,
  );
  expect(saved.markdown).toBe("Carl’s update");
  expect(saved.revision).not.toBe(human.revision);
});

it("offers the Docs guide without a connected workspace or relay calls", async () => {
  const f = await fixture();
  const help = docTools(() => undefined).find(
    (tool) => tool.name === "doc_help",
  );
  if (!help) throw new Error("Missing doc_help");
  const client = f.client();
  const query = vi.spyOn(client, "query");
  const publish = vi.spyOn(client, "publish");
  const guide = await help.call(client, {}, {});
  expect(guide).toContain("buzz://plugin?id=com.squareup.docs");
  expect(guide).toContain("doc_get");
  expect(guide).toContain("doc_set");
  expect(guide).toContain("revision");
  expect(query).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it("rejects foreign-community and malformed doc links before querying", async () => {
  const f = await fixture();
  const original = f.seed("Plan", "Content");
  const get = f.tool("doc_get");
  const client = f.client();
  const query = vi.spyOn(client, "query");
  for (const args of [
    { url: docUrl(original, "https://other.example.test") },
    { url: "buzz://page?id=bad" },
    { url: docUrl(original, f.origin), id: original.id },
    { url: docUrl(original, f.origin), q: "Plan" },
    { q: "x".repeat(513) },
  ])
    await expect(get.call(client, {}, args)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  const channel = f.channels.get(original.channel);
  if (!channel) throw new Error("Missing channel");
  delete channel.roles[client.pubkey];
  await expect(
    get.call(client, {}, { url: docUrl(original, f.origin) }),
  ).rejects.toThrow(/unavailable/);
});

it("gives agents an actionable deleted-doc restore path", async () => {
  const f = await fixture();
  const doc = f.seed("Plan", "Retained text");
  const deleted = await f.workspace.save(
    doc,
    { title: doc.title, markdown: "" },
    "delete",
  );
  const set = f.tool("doc_set"),
    restore = f.tool("doc_delete");
  await expect(
    set.call(
      f.client(),
      {},
      { ...deleted, title: "Plan", text: "Proposed text" },
    ),
  ).rejects.toThrow(/doc_history.*doc_delete.*restore:true/);
  const saved = JSON.parse(
    (await restore.call(
      f.client(),
      {},
      { ...deleted, restore: true, title: "Plan", text: "Retained text" },
    )) as string,
  );
  expect(saved).toMatchObject({ deleted: false, markdown: "Retained text" });
});

it("reports current content and merge instructions for an agent conflict", async () => {
  const f = await fixture();
  const doc = f.seed("Plan", "Original");
  const current = await f.edit(f.carl, doc, {
    title: "Plan",
    markdown: "Concurrent content",
  });
  const set = f.tool("doc_set");
  const failure = await set
    .call(f.client(), {}, { ...doc, title: "Plan", text: "Proposed text" })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("call doc_get, merge");
  expect((failure as Error).message).toContain(current.id);
  expect((failure as Error).message).toContain("Concurrent content");
  expect((failure as Error).message).not.toContain("Your draft is kept");
  expect(f.heads.get(doc.id)?.content).toBe("Concurrent content");
});

it("rejects a revision without its edit channel before reading a file or allocating storage", async () => {
  const f = await fixture();
  const client = f.client();
  const read = vi.spyOn(client, "read");
  const set = f.tool("doc_set");
  await expect(
    set.call(
      client,
      {},
      {
        id: crypto.randomUUID(),
        revision: "a".repeat(64),
        title: "Plan",
        path: "draft.md",
      },
    ),
  ).rejects.toThrow(/channel and id from doc_get/);
  expect(read).not.toHaveBeenCalled();
  expect(f.channels.size).toBe(0);
});

it("uses stable, community-bound doc links across chat and OS ingress", () => {
  const doc = {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "22222222-2222-4222-8222-222222222222",
  };
  const origin = "https://docs.example.test";
  const viewer = "a".repeat(64);
  const url = docUrl(doc, "wss://docs.example.test");
  expect(parseDocUrl(url)).toEqual({
    id: doc.id,
    channel: doc.channel,
    community: origin,
  });
  expect(parseBuzzLink(url)?.format).toBe("plugin");
  const target = buzzLinkTarget(url, {
    viewer,
    communityOrigin: origin,
  });
  expect(target).toMatchObject({
    kind: "plugin",
    pluginId: "com.squareup.docs",
    pageId: "docs",
    params: {
      id: doc.id,
      channel: doc.channel,
      community: origin,
      view: "doc",
    },
  });
  expect(deepLinkStep(url, { viewer, selected: origin })).toEqual({
    open: target,
  });
  expect(parseDocUrl(`${url}&id=${doc.id}`)).toBeUndefined();
  expect(
    parseDocUrl(
      url.replace(
        "https%3A%2F%2Fdocs.example.test",
        "https%3A%2F%2Fevil%40docs.example.test",
      ),
    ),
  ).toBeUndefined();
});

it("lists community view-only docs for nonmembers, retains editor access, and rejects reader-agent writes", async () => {
  const f = await fixture();
  const doc = f.seed("Community plan", "Public history", false);
  const access = f.workspace.generalAccess(doc);
  const base = await access.load(doc.channel);
  await access.save(base, { ...base, visibility: "public", joinRole: "guest" });
  const reader = f.client(f.carl);
  const page = await readDocsPage(
    (filters) => reader.query(filters),
    reader.pubkey,
    f.relay.pubkey,
  );
  expect(page.docs.map((entry) => entry.id)).toContain(doc.id);
  expect(f.channels.get(doc.channel)?.roles[f.carl.pubkey]).toBeUndefined();
  const set = f.tool("doc_set");
  await expect(
    set.call(
      reader,
      {},
      { ...doc, revision: doc.revision, title: "Tampered", text: "Denied" },
    ),
  ).rejects.toThrow(/write denied/);
  await f.workspace.save(doc, {
    title: doc.title,
    markdown: "Owner still edits",
  });
  expect((await f.workspace.open(doc)).markdown).toBe("Owner still edits");
  const latest = await access.load(doc.channel);
  await expect(
    access.save(latest, {
      ...latest,
      visibility: "public",
      joinRole: "member",
    }),
  ).rejects.toThrow(/view-only/);
  await access.save(latest, { ...latest, visibility: "private" });
  expect(
    (
      await readDocsPage(
        (filters) => reader.query(filters),
        reader.pubkey,
        f.relay.pubkey,
      )
    ).docs,
  ).toEqual([]);
});

it("imports a document from a UTF-8 path and returns a safe message reference", async () => {
  const f = await fixture();
  const client = f.client();
  const read = vi
    .spyOn(client, "read")
    .mockResolvedValue(new TextEncoder().encode("# Draft\n\nFrom a file."));
  const set = f.tool("doc_set"),
    get = f.tool("doc_get");
  const title = "A [plan] *with* `code` <b> &amp;\nnext line";
  const created = JSON.parse(
    (await set.call(
      client,
      {},
      { id: crypto.randomUUID(), title, path: "draft.md" },
    )) as string,
  );
  expect(read).toHaveBeenCalledWith("draft.md");
  const verified = JSON.parse(
    (await get.call(client, {}, { url: created.link })) as string,
  );
  expect(verified.markdown).toBe("# Draft\n\nFrom a file.");
  const tree = fromMarkdown(created.message);
  expect(tree.children).toMatchObject([
    {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: created.link,
          children: [{ type: "text", value: title.replace(/\s+/g, " ") }],
        },
      ],
    },
  ]);
  const updated = JSON.parse(
    (await set.call(
      client,
      {},
      {
        id: verified.id,
        channel: verified.channel,
        revision: verified.revision,
        title,
        text: "Updated in place",
      },
    )) as string,
  );
  expect(updated.link).toBe(created.link);
  expect(updated.message).toBe(created.message);
  expect(updated.revision).not.toBe(created.revision);
  expect(f.channels.size).toBe(1);
});

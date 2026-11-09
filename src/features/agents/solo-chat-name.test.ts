import { expect, it, vi } from "vitest";
import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { nameSoloChat } from "./solo-chat-name";

const first = "a".repeat(64),
  second = "b".repeat(64),
  owner = "c".repeat(64);
const event = {
  id: "1".repeat(64),
  pubkey: owner,
  kind: 9,
  created_at: 100,
  content: "Discuss this change",
  tags: [
    ["h", "chat"],
    ["p", first],
    ["p", second],
  ],
} as unknown as RelayEvent;

// The owner's Solo chat, as the relay lists it.
const soloChannels = {
  list: () => ({
    status: "ready",
    channels: [{ id: "chat", channelType: "solo", creator: owner }],
  }),
};

// Session identity stays stable across reads, as it does in the owning service.
function connection(
  snapshot: () => { status: string; viewer: string; session: unknown },
): RelayData {
  const state = snapshot();
  return { snapshot: () => state } as unknown as RelayData;
}

it("only the first tagged agent names an unchanged new Berd chat, once", async () => {
  let name = event.content;
  const save = vi.fn(async (_base, draft) => {
    name = draft.name;
  });
  const load = vi.fn(async () => ({
    name,
    canEdit: true,
    channelId: "chat",
    version: "v1",
  }));
  // The owner's own thread reply is in the same history; it is not the original.
  const reply = {
    ...event,
    id: "3".repeat(64),
    created_at: 90,
    tags: [...event.tags, ["e", "e".repeat(64), "", "reply"]],
  };
  const read = vi.fn(async () => [event, reply]);
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      channels: soloChannels,
      read,
      profiles: { snapshot: () => new Map() },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: { available: true, load, save },
    },
  }));
  await nameSoloChat(relay, owner, second, event, "Second agent wins?");
  expect(load).not.toHaveBeenCalled();
  await nameSoloChat(relay, owner, first, event, "A useful title");
  expect(name).toBe("A useful title");
  // A plain NIP-01 read: the relay rejects a channel-window `until` without a cursor.
  expect(read).toHaveBeenLastCalledWith([
    {
      kinds: [9],
      authors: [owner],
      "#h": ["chat"],
      until: event.created_at,
      limit: 100,
      consistency: "strong",
    },
  ]);
  await nameSoloChat(relay, owner, first, event, "Another title");
  expect(save).toHaveBeenCalledOnce();
  name = "My manual title";
  await nameSoloChat(relay, owner, first, event, "Please overwrite");
  expect(name).toBe("My manual title");
  expect(save).toHaveBeenCalledOnce();
});

it("recognizes a clean starting title from signed recipient tags without stripping literal @ text", async () => {
  const sent = { ...event, content: "@Agent @Literal investigate this" };
  const save = vi.fn();
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      channels: soloChannels,
      read: async () => [sent],
      profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: {
        available: true,
        load: async () => ({
          name: "@Literal investigate this",
          canEdit: true,
        }),
        save,
      },
    },
  }));
  await nameSoloChat(relay, owner, first, sent, "Useful title");
  expect(save).toHaveBeenCalledOnce();
});

it.each(["bold", "bullet_list"])(
  "a %s first draft and its sent message agree on the starting title",
  async (format) => {
    const { startingChatTitle } = await import("../solo/chat-title");
    const { mentionDraft } = await import("../messages/mention-draft");
    const { composerMarkdown } = await import("../messages/composer-markdown");
    const paragraph = {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "fix login",
          ...(format === "bold" ? { marks: [{ type: "bold" }] } : {}),
        },
      ],
    };
    const draft = mentionDraft({
      document: {
        version: 1,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "token",
                  attrs: {
                    source: "@Agent",
                    recipient: { pubkey: first, name: "Agent" },
                    editAsText: false,
                  },
                },
                { type: "text", text: " " },
              ],
            },
            format === "bullet_list"
              ? {
                  type: "bullet_list",
                  content: [{ type: "list_item", content: [paragraph] }],
                }
              : paragraph,
          ],
        },
      },
    });
    const name = startingChatTitle(draft);
    expect(name).toBe(format === "bold" ? "**fix login**" : "- fix login");
    const sent = { ...event, content: composerMarkdown(draft) };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name, canEdit: true }),
          save,
        },
      },
    }));
    await nameSoloChat(relay, owner, first, sent, "Login repair");
    expect(save).toHaveBeenCalledOnce();
  },
);

it.each([first, second])(
  "retry wording and tag order do not change the original naming agent (%s)",
  async (agent) => {
    const retry = {
      ...event,
      id: "2".repeat(64),
      created_at: 110,
      content: "Try again",
      tags: [
        ["h", "chat"],
        ["p", second],
        ["p", first],
      ],
    };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: vi.fn(async () => [retry, event]),
        profiles: { snapshot: () => new Map() },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name: event.content, canEdit: true }),
          save,
        },
      },
    }));
    await nameSoloChat(relay, owner, agent, retry, "A useful title");
    expect(save).toHaveBeenCalledTimes(agent === first ? 1 : 0);
  },
);

it.each(["empty", "full", "same-second", "unrelated", "unsent"])(
  "keeps the title when original-message evidence is %s",
  async (evidence) => {
    const retry = {
      ...event,
      id: "2".repeat(64),
      created_at: 110,
      content: "Try again",
    };
    const history =
      evidence === "empty"
        ? []
        : evidence === "full"
          ? Array.from({ length: 100 }, (_, index) => ({
              ...event,
              id: index.toString(16).padStart(64, "0"),
              created_at: index,
            }))
          : evidence === "unsent"
            ? [{ ...event, delivery: "failed" }, retry]
            : evidence === "same-second"
              ? [event, { ...retry, created_at: event.created_at }]
              : [
                  { ...event, pubkey: second },
                  { ...event, tags: [["h", "other"]] },
                  {
                    ...event,
                    tags: [...event.tags, ["e", "e".repeat(64), "", "reply"]],
                  },
                ];
    const save = vi.fn();
    const load = vi.fn(async () => ({ name: event.content, canEdit: true }));
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => history,
        profiles: { snapshot: () => new Map() },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: { available: true, load, save },
      },
    }));
    await nameSoloChat(relay, owner, first, retry, "Must not replace");
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  },
);

it.each(["history", "details"])(
  "does not rename after the owning session changes during %s",
  async (stage) => {
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn();
    const session = {
      channels: soloChannels,
      read: async () => {
        if (stage === "history") {
          began();
          await gate;
        }
        return [event];
      },
      profiles: { snapshot: () => new Map() },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: {
        available: true,
        load: async () => {
          if (stage === "details") {
            began();
            await gate;
          }
          return { name: event.content, canEdit: true };
        },
        save,
      },
    };
    let current = session;
    const relay = {
      snapshot: () => ({ status: "ready", viewer: owner, session: current }),
    } as unknown as RelayData;
    const work = nameSoloChat(relay, owner, first, event, "Do not rename");
    try {
      await started;
      current = { ...session };
    } finally {
      release();
    }
    await work;
    expect(save).not.toHaveBeenCalled();
  },
);

it.each([
  { chosen: false, caption: "Review this", title: "Review this" },
  { chosen: true, caption: "Review this", title: "Review this" },
  {
    chosen: false,
    caption: "Review [\\#design](buzz://channel/design)",
    title: "Review #design",
  },
  {
    chosen: true,
    caption: "Review [\\#design](buzz://channel/design)",
    title: "Review #design",
  },
])(
  "staged cards and $caption preserve automatic naming and chosen names (chosen=$chosen)",
  async ({ chosen, caption, title }) => {
    const { startingChatTitle } = await import("../solo/chat-title");
    const { composerMarkdown } = await import("../messages/composer-markdown");
    const draft = {
      text: `@Agent ${caption}`,
      recipients: [{ pubkey: first, name: "Agent", start: 0, end: 6 }],
      chatCards: ["[Session: Fix](buzz://channel/session-id)"],
    };
    const name = startingChatTitle(draft);
    expect(name).toBe(title);
    const sent = { ...event, content: composerMarkdown(draft) };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({
            name,
            labels: chosen ? ["buzz.session.named"] : [],
            canEdit: true,
          }),
          save,
        },
      },
    }));
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).toHaveBeenCalledTimes(chosen ? 0 : 1);
  },
);

it.each([
  "Review [\\#design](buzz://channel/design)",
  `Review [\\#design](buzz://channel/${"x".repeat(100)})`,
  `Review 😀 [\\#design](buzz://channel/${"x".repeat(100)})`,
  "[Session: Fix](buzz://channel/session-id)",
])(
  "recognizes the legacy starting title for %s without overwriting chosen names",
  async (caption) => {
    // Persist the old algorithm's literal, truncated title, not the new helper's result.
    const legacyName = [...caption].slice(0, 80).join("");
    const sent = { ...event, content: `@Agent ${caption}` };
    let name = legacyName;
    let labels: string[] = [];
    const save = vi.fn(async (_base, draft) => {
      name = draft.name;
    });
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name, labels, canEdit: true }),
          save,
        },
      },
    }));
    // Even a chosen name equal to the legacy default must remain protected.
    labels = ["buzz.session.named"];
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).not.toHaveBeenCalled();
    labels = [];
    name = "My manual title";
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).not.toHaveBeenCalled();
    name = legacyName;
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).toHaveBeenCalledOnce();
    expect(name).toBe("Useful title");
    await nameSoloChat(relay, owner, first, sent, "Another title");
    expect(save).toHaveBeenCalledOnce();
  },
);

it("an agent tag without a caption retains the session-card starting title", async () => {
  const { startingChatTitle } = await import("../solo/chat-title");
  expect(
    startingChatTitle({
      text: "@Agent ",
      recipients: [{ pubkey: first, name: "Agent", start: 0, end: 6 }],
      chatCards: ["[Session: Fix](buzz://channel/session-id)"],
    }),
  ).toBe("Session: Fix");
});

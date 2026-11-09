import { expect, it, vi, assert } from "vitest";
import { foldMessages } from "../relay/fold";
import { attachmentMessage } from "../relay/attachments";
import { createRelaySession } from "../relay/session";
import { createHuddleDiscussion } from "./discussion";
import type { ReadOptions } from "../relay/reader";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { createRelayReader } from "../relay/reader";
import { keypair, signed, scriptedTransport } from "../relay/testing";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";

function harness(room = "room", delivery: "failed" | "unknown" = "failed") {
  const owner = createRelaySession(null),
    viewer = "ab".repeat(32),
    parent = "parent";
  let metadata: ChannelSummary = {
    id: room,
    name: "Huddle",
    huddle: true,
    parentChannelId: parent,
  };
  let rows: ChannelMessage[] = [];
  const send = vi.fn(() => "id"),
    retry = vi.fn((_id: string, _allowed: () => boolean) => {}),
    dismiss = vi.fn(async () => {});
  const listeners = new Set<() => void>();
  const pending = {
    event: {
      id: "failed",
      pubkey: viewer,
      created_at: 1,
      kind: 9,
      tags: [["h", room]],
      content: "Hello",
    },
    delivery,
  };
  const authority = keypair();
  const read = vi.fn(
    async (
      _filters: readonly ReadFilter[],
      _options?: ReadOptions,
    ): Promise<readonly RelayEvent[]> => [],
  );
  const ensure = vi.fn();
  const loadOlder = vi.fn();
  let hasMore = true;
  let historyError: string | undefined;
  const profiles = new Map<string, { name: string; picture: string }>();
  const session = {
    ...owner.session,
    profiles: { ...owner.session.profiles, snapshot: () => profiles },
    viewer,
    relayAuthor: authority.pubkey,
    media: (url: string) =>
      `http://buzz-media.localhost/${encodeURIComponent(url)}`,
    read,
    messages: { ...owner.session.messages, send },
    outbox: {
      subscribe: () => () => {},
      observeDismiss: () => () => {},
      observeSend: () => () => {},
      supports: () => true,
      ready: async () => {},
      send: () => "id",
      recovery: async () => undefined,
      recover: async () => {},
      acknowledge: async () => {},
      snapshot: () => [pending],
      retry,
      dismiss,
    },
    channels: {
      ...owner.session.channels,
      get: () => metadata,
      resolve: async () => {},
      ensure,
      loadOlder,
      subscribeWindow: (_id: string, fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      window: () => ({
        channelId: room,
        status: "ready" as const,
        rows,
        loadingOlder: false,
        hasMore,
        error: historyError,
      }),
    },
  };
  const discussion = createHuddleDiscussion(session, room, parent, vi.fn());
  return {
    owner,
    profiles,
    authority,
    read,
    ensure,
    discussion,
    loadOlder,
    historyError: (value: string) => {
      historyError = value;
    },
    hasMore: (value: boolean) => {
      hasMore = value;
    },
    send,
    retry,
    dismiss,
    metadata: (next: ChannelSummary) => {
      metadata = next;
    },
    rows: (next: ChannelMessage[]) => {
      rows = next;
    },
    dispose: () => {
      discussion.dispose();
      owner.dispose();
    },
  };
}
it("only reads and sends to a verified Huddle belonging to this parent", async () => {
  const h = harness();
  h.metadata({ id: "room", name: "Ordinary channel" });
  try {
    await vi.waitFor(() =>
      expect(h.discussion.snapshot().status).toBe("error"),
    );
    await h.discussion.send("Wrong destination");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.discussion.snapshot().rows).toEqual([]);
  } finally {
    h.dispose();
  }
});
it("bounds native presentation and offers room-bound failure recovery", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.discussion.snapshot().writable).toBe(true));
    h.rows(
      Array.from({ length: 513 }, (_, i) => ({
        id: String(i),
        channelId: "room",
        authorId: "ab".repeat(32),
        createdAt: i,
        content: "message",
        mentions: [],
        attachments: [],
        reactions: [],
        participants: [],
        replyCount: 0,
      })),
    );
    expect(h.discussion.snapshot()).toMatchObject({
      historyLimited: true,
      hasMore: false,
    });
    expect(h.discussion.snapshot().rows).toHaveLength(200);
    await h.discussion.send("Hello");
    expect(h.send).toHaveBeenCalledWith("room", "Hello");
    h.discussion.recover("other");
    expect(h.retry).not.toHaveBeenCalled();
    h.discussion.recover("failed");
    expect(h.retry).toHaveBeenCalledWith("failed", expect.any(Function));
    h.discussion.recover("failed", true);
    expect(h.dismiss).toHaveBeenCalledWith("failed");
    const retryAllowed = h.retry.mock.calls[0]?.[1];
    assert.exists(retryAllowed);
    h.discussion.dispose();
    // An accepted delivery outlives its panel, but still checks current room access.
    expect(retryAllowed()).toBe(true);
    h.metadata({
      id: "room",
      name: "Huddle",
      huddle: true,
      parentChannelId: "parent",
      archived: true,
    });
    expect(retryAllowed()).toBe(false);
    await h.discussion.send("Late");
    expect(h.send).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

const legacyRoom = "33333333-3333-4333-8333-333333333333";
const legacyMetadata: ChannelSummary = {
  id: legacyRoom,
  name: "General huddle",
  visibility: "private",
  channelType: "stream",
};
function evidence(
  h: ReturnType<typeof harness>,
  overrides: {
    author?: ReturnType<typeof keypair>;
    parent?: string;
    room?: string;
    kind?: number;
  } = {},
) {
  return signed(overrides.author ?? h.authority, {
    kind: overrides.kind ?? 48101,
    content: JSON.stringify({
      ephemeral_channel_id: overrides.room ?? legacyRoom,
    }),
    tags: [["h", overrides.parent ?? "parent"]],
  });
}
it("opens an unmarked legacy room using signed relay activity and keeps archive/access restrictions", async () => {
  const h = harness(legacyRoom);
  h.metadata(legacyMetadata);
  h.read.mockResolvedValue([evidence(h)]);
  try {
    await vi.waitFor(() => expect(h.discussion.snapshot().writable).toBe(true));
    expect(h.ensure).toHaveBeenCalledWith(legacyRoom);
    await h.discussion.send("Legacy reply");
    expect(h.send).toHaveBeenCalledWith(legacyRoom, "Legacy reply");
    h.metadata({ ...legacyMetadata, archived: true });
    expect(h.discussion.available()).toBe(true);
    expect(h.discussion.snapshot().writable).toBe(false);
    h.metadata({ ...legacyMetadata, readOnly: true });
    expect(h.discussion.snapshot().writable).toBe(false);
    h.metadata({ ...legacyMetadata, cached: true });
    expect(h.discussion.snapshot().writable).toBe(false);
    h.metadata({ ...legacyMetadata, huddle: true, parentChannelId: "other" });
    expect(h.discussion.available()).toBe(false);
    expect(h.discussion.snapshot().rows).toEqual([]);
  } finally {
    h.dispose();
  }
});
it.each(["author", "parent", "room", "kind", "missing"])(
  "rejects legacy evidence with wrong %s",
  async (invalid) => {
    const h = harness(legacyRoom);
    h.metadata(legacyMetadata);
    h.read.mockResolvedValue(
      invalid === "missing"
        ? []
        : [
            evidence(h, {
              ...(invalid === "author" ? { author: keypair() } : {}),
              ...(invalid === "parent" ? { parent: "other" } : {}),
              ...(invalid === "room"
                ? { room: "44444444-4444-4444-8444-444444444444" }
                : {}),
              ...(invalid === "kind" ? { kind: 48100 } : {}),
            }),
          ],
    );
    try {
      await vi.waitFor(() =>
        expect(h.discussion.snapshot().status).toBe("error"),
      );
      expect(h.ensure).not.toHaveBeenCalled();
      await h.discussion.send("Wrong room");
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);
it("retries a failed legacy read and ignores its completion after disposal", async () => {
  const h = harness(legacyRoom);
  h.metadata(legacyMetadata);
  h.read.mockRejectedValueOnce(new Error("offline"));
  try {
    await vi.waitFor(() =>
      expect(h.discussion.snapshot().status).toBe("error"),
    );
    let finish!: (events: readonly RelayEvent[]) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.discussion.retry();
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    h.discussion.dispose();
    finish([evidence(h)]);
    await Promise.resolve();
    expect(h.ensure).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it("verifies legacy evidence through the real relay reader admission boundary", async () => {
  const h = harness(legacyRoom);
  h.metadata(legacyMetadata);
  const transport = scriptedTransport("ab".repeat(32), h.authority.pubkey);
  const reader = createRelayReader(transport.transport);
  h.read.mockImplementation(reader.reader.read);
  try {
    await vi.waitFor(() => expect(transport.pending).toHaveLength(1));
    transport.next().respond([evidence(h)]);
    await vi.waitFor(() => expect(h.discussion.snapshot().writable).toBe(true));
    expect(h.ensure).toHaveBeenCalledWith(legacyRoom);
  } finally {
    h.dispose();
    reader.dispose();
  }
});

it.each(["failed", "unknown"] as const)(
  "preserves %s delivery and recovers the same room-bound event",
  async (delivery) => {
    const h = harness("room", delivery);
    try {
      await vi.waitFor(() =>
        expect(h.discussion.snapshot().writable).toBe(true),
      );
      h.rows([
        {
          id: "failed",
          channelId: "room",
          authorId: "ab".repeat(32),
          createdAt: 1,
          content: "Hello",
          delivery,
          mentions: [],
          attachments: [],
          reactions: [],
          participants: [],
          replyCount: 0,
        },
      ]);
      expect(h.discussion.snapshot().rows[0]?.delivery).toBe(delivery);
      h.discussion.recover("failed");
      expect(h.retry).toHaveBeenCalledWith("failed", expect.any(Function));
      expect(h.send).not.toHaveBeenCalled();
      h.discussion.recover("failed", true);
      expect(h.dismiss).toHaveBeenCalledWith("failed");
      h.metadata({
        id: "room",
        name: "Huddle",
        huddle: true,
        parentChannelId: "parent",
        readOnly: true,
      });
      h.discussion.recover("failed");
      expect(h.retry).toHaveBeenCalledTimes(1);
    } finally {
      h.dispose();
    }
  },
);

it("preserves sent attachment metadata and resolved media in the window presentation", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.discussion.snapshot().writable).toBe(true));
    const files = [
      {
        name: "voice-note-test.mp4",
        type: "video/mp4",
        voice: { duration: 1.5, waveform: [0, 25, 100] },
        size: 23,
        sha256: "a".repeat(64),
        url: `https://fixture.example/media/${"a".repeat(64)}.mp4`,
      },
      {
        name: "photo.png",
        type: "image/png",
        size: 100,
        sha256: "b".repeat(64),
        url: `https://fixture.example/media/${"b".repeat(64)}.png`,
      },
    ];
    const sent = attachmentMessage(
      "**Meeting notes**",
      files,
      "https://fixture.example",
    );
    const rows = foldMessages("room", h.authority.pubkey, [
      {
        id: "message",
        pubkey: "ab".repeat(32),
        kind: 9,
        created_at: 1,
        content: sent.content,
        tags: [["h", "room"], ...sent.tags],
      },
    ]);
    h.rows(rows);
    const row = h.discussion.snapshot().rows[0];
    const folded = rows[0];
    assert(row && folded);
    expect(row).toMatchObject({
      authorId: "ab".repeat(32),
      channelId: "room",
      text: "**Meeting notes**",
    });
    expect(row.attachments).toEqual(
      folded.attachments.map((attachment) => ({
        ...attachment,
        source: `http://buzz-media.localhost/${encodeURIComponent(attachment.url)}`,
        previewSource: null,
      })),
    );
    expect(row.attachments[0]).toMatchObject({
      voiceNote: true,
      kind: "audio",
    });
    h.rows([
      {
        ...folded,
        attachments: [
          { url: `https://example.test/${"a".repeat(8192)}`, kind: "file" },
          {
            url: "https://example.test/file",
            kind: "file",
            mime: "界".repeat(100),
            name: "😀".repeat(1100),
            previewUrl: `https://example.test/${"a".repeat(8192)}`,
          },
          ...folded.attachments,
        ],
      },
    ]);
    const projected = h.discussion.snapshot().rows[0];
    expect(projected?.attachments).toHaveLength(3);
    expect(projected?.attachments[0]).toEqual({
      url: "https://example.test/file",
      kind: "file",
      source: "http://buzz-media.localhost/https%3A%2F%2Fexample.test%2Ffile",
      previewSource: null,
    });
    expect(row.attachments.map((attachment) => attachment.kind)).toEqual([
      "audio",
      "image",
    ]);
  } finally {
    h.dispose();
  }
});

it("counts visible messages before limiting history and keeps older paging available", async () => {
  const h = harness();
  const message = (i: number): ChannelMessage => ({
    id: String(i),
    channelId: "room",
    authorId: "ab".repeat(32),
    createdAt: i,
    content: "message",
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  });
  const notices = Array.from({ length: 200 }, (_, i) => ({
    ...message(i),
    membership: {
      type: "member_joined" as const,
      actor: "ab".repeat(32),
      target: "ab".repeat(32),
    },
  }));
  try {
    await vi.waitFor(() => expect(h.discussion.snapshot().writable).toBe(true));
    h.rows([...Array.from({ length: 199 }, (_, i) => message(i)), ...notices]);
    expect(h.discussion.snapshot()).toMatchObject({
      hasMore: true,
      historyLimited: false,
    });
    expect(h.discussion.snapshot().rows).toHaveLength(199);
    h.discussion.older();
    expect(h.loadOlder).toHaveBeenCalledWith("room");
    h.rows([...Array.from({ length: 201 }, (_, i) => message(i)), ...notices]);
    expect(h.discussion.snapshot()).toMatchObject({
      hasMore: false,
      historyLimited: true,
    });
    expect(h.discussion.snapshot().rows).toHaveLength(200);
    expect(h.discussion.snapshot().rows[0]?.id).toBe("1");
    h.discussion.older();
    expect(h.loadOlder).toHaveBeenCalledTimes(1);
    h.rows([message(0), ...notices]);
    h.hasMore(false);
    expect(h.discussion.snapshot()).toMatchObject({
      hasMore: false,
      historyLimited: false,
    });
  } finally {
    h.dispose();
  }
});

it("preserves signed mention evidence and edit boundaries while bounding discussion avatars", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.discussion.snapshot().writable).toBe(true));
    h.rows([
      {
        id: "mention",
        channelId: "room",
        authorId: "ab".repeat(32),
        createdAt: 1,
        content: "@Taylor",
        mentions: ["cd".repeat(32)],
        mentionReferences: ["ef".repeat(32)],
        edited: true,
        attachmentSeams: [3],
        attachments: [],
        reactions: [],
        participants: [],
        replyCount: 0,
      },
    ]);
    h.profiles.set("ab".repeat(32), {
      name: "Author",
      picture: `data:image/png;base64,${"a".repeat(9000)}`,
    });
    expect(h.discussion.snapshot().rows[0]?.picture).toBeNull();
    expect(h.discussion.snapshot().rows[0]?.pictureUrl).toBeNull();
    h.profiles.set("ab".repeat(32), {
      name: "Author",
      picture: "https://example.test/avatar.png",
    });
    expect(h.discussion.snapshot().rows[0]?.picture).toBe(
      "http://buzz-media.localhost/https%3A%2F%2Fexample.test%2Favatar.png",
    );
    expect(h.discussion.snapshot().rows[0]).toMatchObject({
      pictureUrl: "https://example.test/avatar.png",
      mentions: ["cd".repeat(32)],
      mentionReferences: ["ef".repeat(32)],
      edited: true,
      attachmentSeams: [3],
    });
  } finally {
    h.dispose();
  }
});

it("retries a failed older page instead of reloading metadata", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.ensure).toHaveBeenCalled());
    h.historyError("Page unavailable");
    h.discussion.retry();
    expect(h.loadOlder).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

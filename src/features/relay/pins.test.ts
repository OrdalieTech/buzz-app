import { assert, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "./events";
import type { LiveListener } from "./incoming";
import { OLD_EVENT_NOT_FOUND, PublishRejected } from "./outbox";
import { acceptPublish } from "./transport";
import {
  EXPIRED_PIN_RECOVERY,
  refusedPinCommand,
  LOADING_PINS,
  PIN_KIND,
  PIN_LIST_KIND,
  pinLists,
  pinnedIds,
  readPinnedMessages,
  type PinSource,
  UNSUPPORTED_PIN_RECOVERY,
  UNPIN_KIND,
} from "./pins";

const relay = "a".repeat(64);
const other = "b".repeat(64);
const one = "1".repeat(64),
  two = "2".repeat(64),
  three = "3".repeat(64);
let serial = 0;
const event = (patch: Partial<EventData>): EventData => ({
  id: (serial++).toString(16).padStart(64, "0"),
  pubkey: relay,
  created_at: 100,
  kind: PIN_LIST_KIND,
  tags: [["d", "c"]],
  content: "",
  ...patch,
});
const list = (ids: string[], created_at = 100, channel = "c") =>
  event({
    created_at,
    tags: [["d", channel], ...ids.map((id) => ["e", id])],
  });

function source(
  read: (filters: readonly ReadFilter[]) => Promise<readonly EventData[]>,
  relayAuthor: string | null = relay,
  extra: Partial<PinSource> = {},
) {
  const listeners: LiveListener[] = [];
  const replays: boolean[] = [];
  const connection = new Set<() => void>();
  let heads: { channelId: string; state: string }[] = [];
  const value: PinSource = {
    relayAuthor: relayAuthor ?? undefined,
    workflowAuthority: relayAuthor ?? undefined,
    read: vi.fn(read),
    async readPage(filters, settings) {
      const events = await value.read(filters, settings);
      return { events, relayCount: events.length };
    },
    subscribeLive(listener, options) {
      listeners.push(listener);
      replays.push(!!options?.replay);
      return () => {};
    },
    live: {
      snapshot: () => ({ heads }),
      subscribe(listener) {
        connection.add(listener);
        return () => connection.delete(listener);
      },
    },
    ...extra,
  };
  const deliver = (events: EventData[]) => {
    // The store reads only kind, pubkey, tags and created_at.
    for (const listener of listeners)
      listener({ events } as unknown as Parameters<LiveListener>[0]);
  };
  // Channels whose routes re-establish read their heads again, then settle.
  const catchUp = (channels: string[]) => {
    for (const state of ["pending", "verified"]) {
      heads = channels.map((channelId) => ({ channelId, state }));
      for (const listener of connection) listener();
    }
  };
  return { value, deliver, replays, catchUp };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("reads only a relay-signed list for its own channel, in order and deduped", () => {
  expect(pinnedIds(list([two, one, two, "bad"]), relay, "c")).toEqual([
    two,
    one,
  ]);
  expect(pinnedIds(list([one]), other, "c")).toBeUndefined();
  expect(pinnedIds(list([one], 100, "d"), relay, "c")).toBeUndefined();
  expect(pinnedIds(list([one]), undefined, "c")).toBeUndefined();
  expect(pinnedIds({ ...list([one]), kind: 9 }, relay, "c")).toBeUndefined();
  // An empty list is a d-only event.
  expect(pinnedIds(list([]), relay, "c")).toEqual([]);
});

it("reads the newest list once, then follows live and replayed lists", async () => {
  const filters: ReadFilter[][] = [];
  const s = source(async (read) => {
    filters.push([...read]);
    return [list([one])];
  });
  const store = pinLists(s.value);
  expect(pinLists(s.value)).toBe(store);
  const listener = vi.fn();
  store.subscribe("c", listener);
  store.subscribe("c", () => {});
  expect(store.snapshot("c").status).toBe("loading");
  await flush();
  expect(filters).toEqual([
    [
      {
        kinds: [PIN_LIST_KIND],
        authors: [relay],
        "#h": ["c"],
        limit: 1,
        consistency: "strong",
      },
    ],
  ]);
  // One replay listener: it hears live batches too.
  expect(s.replays).toEqual([true]);
  expect(store.snapshot("c")).toMatchObject({ status: "ready", ids: [one] });
  // A future-dated list is accepted; an older or foreign one is not.
  s.deliver([list([two, one], 9_999_999_999)]);
  expect(store.snapshot("c").ids).toEqual([two, one]);
  s.deliver([list([three], 101), { ...list([three]), pubkey: other }]);
  expect(store.snapshot("c").ids).toEqual([two, one]);
  expect(store.snapshot("c").set.has(two)).toBe(true);
  s.deliver([list([], 10_000_000_000)]);
  expect(store.snapshot("c").ids).toEqual([]);
  expect(listener).toHaveBeenCalled();
  expect(s.value.read).toHaveBeenCalledTimes(1);
});

it("treats no list as empty, shows none without relay self, and retries a failed read only when asked", async () => {
  const empty = source(async () => []);
  pinLists(empty.value).subscribe("c", () => {});
  await flush();
  expect(pinLists(empty.value).snapshot("c")).toMatchObject({
    status: "ready",
    ids: [],
  });

  const anonymous = source(async () => [list([one])], null);
  pinLists(anonymous.value).subscribe("c", () => {});
  await flush();
  expect(anonymous.value.read).not.toHaveBeenCalled();
  expect(pinLists(anonymous.value).snapshot("c").status).toBe("ready");
  anonymous.deliver([list([one])]);
  expect(pinLists(anonymous.value).snapshot("c").ids).toEqual([]);
  // A contact key standing in for `relayAuthor` is not the relay's `self`.
  const contact = source(async () => [list([one])], relay, {
    workflowAuthority: undefined,
  });
  pinLists(contact.value).subscribe("c", () => {});
  await flush();
  expect(contact.value.read).not.toHaveBeenCalled();
  contact.deliver([list([one])]);
  expect(pinLists(contact.value).snapshot("c").ids).toEqual([]);

  let fail = true;
  const flaky = source(async () => {
    if (fail) throw new Error("offline");
    return [list([one])];
  });
  const store = pinLists(flaky.value);
  const stop = store.subscribe("c", () => {});
  await flush();
  expect(store.snapshot("c").status).toBe("error");
  // Another reader of the failed list, as a second marker, reads nothing.
  const other = store.subscribe("c", () => {});
  await flush();
  expect(flaky.value.read).toHaveBeenCalledTimes(1);
  // Revisiting the channel tries once more.
  stop();
  other();
  store.subscribe("c", () => {});
  await flush();
  expect(flaky.value.read).toHaveBeenCalledTimes(2);
  expect(store.snapshot("c").status).toBe("error");
  fail = false;
  store.retry("c");
  expect(store.snapshot("c").status).toBe("loading");
  await flush();
  expect(store.snapshot("c")).toMatchObject({ status: "ready", ids: [one] });
});

it("reads watched lists again in one read when their channels catch up", async () => {
  const filters: ReadFilter[][] = [];
  const s = source(async (read) => {
    filters.push([...read]);
    return filters.length > 2
      ? [list([two], 200), list([three], 200, "d")]
      : [];
  });
  const store = pinLists(s.value);
  store.subscribe("c", () => {});
  store.subscribe("d", () => {});
  const stop = store.subscribe("e", () => {});
  await flush();
  stop();
  s.catchUp(["c", "d", "e"]);
  await flush();
  // The unwatched list is dropped, and read again when next asked for.
  expect(filters.at(-1)).toEqual([
    {
      kinds: [PIN_LIST_KIND],
      authors: [relay],
      "#h": ["c", "d"],
      limit: 2,
      consistency: "strong",
    },
  ]);
  expect(store.snapshot("c").ids).toEqual([two]);
  expect(store.snapshot("d").ids).toEqual([three]);
  expect(store.snapshot("e")).toBe(LOADING_PINS);
});

it("reads a list once more when asked during a read already running", async () => {
  const gates: (() => void)[] = [];
  let reply = [list([one])];
  const s = source(async () => {
    const answer = reply;
    await new Promise<void>((resolve) => gates.push(resolve));
    return answer;
  });
  const store = pinLists(s.value);
  store.subscribe("c", () => {});
  await flush();
  expect(gates).toHaveLength(1);
  // The list changed during the gap; catch-up and a refusal's reread both
  // ask while the first read, sent before the change, still runs.
  reply = [list([two], 200)];
  s.catchUp(["c"]);
  store.retry("c");
  expect(gates).toHaveLength(1);
  gates.shift()?.();
  await flush();
  expect(gates).toHaveLength(1);
  gates.shift()?.();
  await flush();
  expect(s.value.read).toHaveBeenCalledTimes(2);
  expect(store.snapshot("c").ids).toEqual([two]);
});

it("keeps a shown list through a failed catch-up read and repairs it on the next", async () => {
  let reply: () => readonly EventData[] = () => [list([one])];
  const s = source(async () => reply());
  const store = pinLists(s.value);
  store.subscribe("c", () => {});
  await flush();
  reply = () => {
    throw new Error("offline");
  };
  s.catchUp(["c"]);
  await flush();
  expect(store.snapshot("c")).toMatchObject({ status: "ready", ids: [one] });
  reply = () => [list([two], 200)];
  s.catchUp(["c"]);
  await flush();
  expect(store.snapshot("c")).toMatchObject({ status: "ready", ids: [two] });
});

it("loads pinned messages with edits applied and drops ids the relay no longer returns", async () => {
  const author = "c".repeat(64);
  const message = event({
    id: one,
    pubkey: author,
    kind: 9,
    content: "before",
    tags: [["h", "c"]],
  });
  const edit = event({
    pubkey: author,
    kind: 40003,
    created_at: 101,
    content: "after",
    tags: [
      ["h", "c"],
      ["e", one],
    ],
  });
  const filters: ReadFilter[][] = [];
  const s = source(async (read) => {
    filters.push([...read]);
    return [message, edit];
  });
  const { rows } = await readPinnedMessages(
    s.value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  expect([...rows.keys()]).toEqual([one]);
  expect(rows.get(one)?.content).toBe("after");
  expect(filters[0]?.[0]).toMatchObject({ ids: [one, two], "#h": ["c"] });
  expect(filters[1]?.[0]).toMatchObject({ "#e": [one, two] });

  const many = Array.from({ length: 150 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  filters.length = 0;
  await readPinnedMessages(s.value, "c", many, new AbortController().signal);
  expect(
    filters.flatMap((read) => (read[0]?.ids ? [read[0].ids.length] : [])),
  ).toEqual([100, 50]);
});

it("pages edits newest first over every pin, whoever references them", async () => {
  const author = "c".repeat(64),
    stranger = "d".repeat(64);
  const message = (id: string, pubkey: string) =>
    event({ id, pubkey, kind: 9, content: "original", tags: [["h", "c"]] });
  const edit = (
    pubkey: string,
    targets: string[],
    created_at: number,
    content: string,
  ) =>
    event({
      pubkey,
      kind: 40003,
      created_at,
      content,
      tags: [["h", "c"], ...targets.map((id) => ["e", id])],
    });
  // A full page of a stranger's edits to their own message, each also naming
  // `two`, pushes `two`'s author's correction to a later page.
  const newer = Array.from({ length: 500 }, (_, index) =>
    edit(stranger, [one, two], 1000 + index, `one ${index}`),
  );
  const overlays: ReadFilter[] = [];
  const s = source(async ([filter]) => {
    if (filter?.ids) return [message(one, stranger), message(two, author)];
    assert.exists(filter);
    overlays.push(filter);
    return overlays.length === 1
      ? newer
      : [edit(author, [two], 900, "two edited")];
  });
  const { rows } = await readPinnedMessages(
    s.value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  const overlay = {
    kinds: [5, 9005, 40003],
    "#e": [one, two],
    "#h": ["c"],
    limit: 500,
  };
  expect(overlays).toEqual([
    { ...overlay, consistency: "strong" },
    {
      ...overlay,
      consistency: "strong",
      until: 1000,
      before_id: newer[0]?.id,
    },
  ]);
  expect(rows.get(one)?.content).toBe("one 499");
  expect(rows.get(two)?.content).toBe("two edited");
});

// The relay's order and keyset cursor (created_at DESC, id ASC).
const relayPage = (corpus: readonly EventData[], filter: ReadFilter) =>
  [...corpus]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .filter(
      (event) =>
        filter.until === undefined ||
        event.created_at < filter.until ||
        (event.created_at === filter.until &&
          (filter.before_id === undefined || event.id > filter.before_id)),
    )
    .slice(0, filter.limit);

it("classifies a pin command refused as too old or unsupported", async () => {
  const command = (kind: number, error?: string) => ({
    event: event({ kind, tags: [["h", "c"]] }),
    error,
  });
  // The relay's refusal as the transport reports it.
  const refused = await acceptPublish(
    Response.json(
      { error: "invalid: event timestamp too far from server time" },
      { status: 400 },
    ),
    "pin",
  ).catch((error: unknown) => error);
  assert.instanceOf(refused, PublishRejected);
  const relayRefusal = refused.message;
  expect(refusedPinCommand(command(PIN_KIND, relayRefusal))).toBe(
    EXPIRED_PIN_RECOVERY,
  );
  expect(
    refusedPinCommand(command(UNPIN_KIND, `Retry blocked: ${relayRefusal}`)),
  ).toBe(EXPIRED_PIN_RECOVERY);
  expect(
    refusedPinCommand(
      command(PIN_KIND, `Retry blocked: ${OLD_EVENT_NOT_FOUND}`),
    ),
  ).toBe(EXPIRED_PIN_RECOVERY);
  // A relay without NIP-PM, as the transport reports it.
  const unsupported = await acceptPublish(
    Response.json({ error: "restricted: unknown event kind" }, { status: 400 }),
    "pin",
  ).catch((error: unknown) => error);
  assert.instanceOf(unsupported, PublishRejected);
  expect(refusedPinCommand(command(UNPIN_KIND, unsupported.message))).toBe(
    UNSUPPORTED_PIN_RECOVERY,
  );
  expect(
    refusedPinCommand(command(PIN_KIND, "blocked: not a member")),
  ).toBeUndefined();
  expect(refusedPinCommand(command(PIN_KIND))).toBeUndefined();
  // Other kinds keep their own retry rules.
  expect(refusedPinCommand(command(9, relayRefusal))).toBeUndefined();
  expect(refusedPinCommand(command(9, unsupported.message))).toBeUndefined();
});

it("pages through one second holding more than a full page", async () => {
  const author = "c".repeat(64),
    other = "d".repeat(64);
  const edit = (
    pubkey: string,
    target: string,
    created_at: number,
    content: string,
  ) =>
    event({
      pubkey,
      kind: 40003,
      created_at,
      content,
      tags: [
        ["h", "c"],
        ["e", target],
      ],
    });
  const corpus = [
    ...Array.from({ length: 501 }, (_, index) =>
      edit(author, one, 1000, `one ${index}`),
    ),
    edit(other, two, 900, "corrected by other"),
  ];
  const pages: ReadFilter[] = [];
  const s = source(async ([filter]) =>
    filter?.ids
      ? [
          event({ id: one, pubkey: author, kind: 9, tags: [["h", "c"]] }),
          event({ id: two, pubkey: other, kind: 9, tags: [["h", "c"]] }),
        ]
      : [],
  );
  const value: PinSource = {
    ...s.value,
    async readPage([filter], settings) {
      assert.exists(filter);
      if (filter.ids)
        return {
          events: await s.value.read([filter], settings),
          relayCount: 0,
        };
      pages.push(filter);
      const page = relayPage(corpus, filter);
      return { events: page, relayCount: page.length };
    },
  };
  const { rows } = await readPinnedMessages(
    value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  expect(pages).toHaveLength(2);
  expect(pages[1]?.until).toBe(1000);
  expect(rows.get(two)?.content).toBe("corrected by other");
});

it("pages past filtered full pages and a second shared by two pages", async () => {
  const author = "c".repeat(64);
  const edit = (created_at: number, target: string, content: string) =>
    event({
      pubkey: author,
      kind: 40003,
      created_at,
      content,
      tags: [
        ["h", "c"],
        ["e", target],
      ],
    });
  // 499 newer edits of `one`, then two at second 1000. Ties order by id, so
  // `two`'s edit, made last, falls to the second page.
  const corpus = [
    ...Array.from({ length: 499 }, (_, index) =>
      edit(1001 + index, one, `one ${index}`),
    ),
    edit(1000, one, "one oldest"),
    edit(1000, two, "two edited"),
  ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  // The session hides one event of the first page, as visibility may.
  const hidden = corpus[10]?.id;
  const pages: ReadFilter[] = [];
  const s = source(async ([filter]) =>
    filter?.ids
      ? filter.ids.map((id) =>
          event({ id, pubkey: author, kind: 9, tags: [["h", "c"]] }),
        )
      : [],
  );
  const value: PinSource = {
    ...s.value,
    async readPage([filter], settings) {
      if (filter?.ids)
        return {
          events: await s.value.read([filter], settings),
          relayCount: 0,
        };
      assert.exists(filter);
      pages.push(filter);
      const page = relayPage(corpus, filter);
      return {
        events: page.filter((event) => event.id !== hidden),
        relayCount: page.length,
      };
    },
  };
  const { rows } = await readPinnedMessages(
    value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  expect(pages.map((page) => page.until)).toEqual([undefined, 1000]);
  expect(rows.get(one)?.content).toBe("one 498");
  expect(rows.get(two)?.content).toBe("two edited");
});

it("folds pins with the session's signing authority and agent owners", async () => {
  const agent = "d".repeat(64),
    owner = "e".repeat(64),
    person = "f".repeat(64);
  const agentMessage = event({
    id: one,
    pubkey: agent,
    kind: 9,
    content: "draft",
    tags: [["h", "c"]],
  });
  const ownerEdit = event({
    pubkey: owner,
    kind: 40003,
    created_at: 101,
    content: "fixed by owner",
    tags: [
      ["h", "c"],
      ["e", one],
    ],
  });
  const relayed = event({
    id: two,
    pubkey: relay,
    kind: 9,
    content: "sent for someone",
    tags: [
      ["h", "c"],
      ["actor", person],
    ],
  });
  const s = source(
    async ([filter]) => (filter?.ids ? [agentMessage, relayed] : [ownerEdit]),
    relay,
    {
      workflowAuthority: relay,
      profiles: { owner: (pubkey) => (pubkey === agent ? owner : undefined) },
    },
  );
  const { rows } = await readPinnedMessages(
    s.value,
    "c",
    [one, two],
    new AbortController().signal,
  );
  expect(rows.get(one)?.content).toBe("fixed by owner");
  expect(rows.get(two)?.authorId).toBe(person);
});

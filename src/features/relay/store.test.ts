import { assert, describe, expect, it, vi } from "vitest";
import { huddleDescription } from "../huddle/lifecycle";
import { ReadError } from "./errors";
import { listByteSize } from "./budget";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import type { HeadPersistence, SavedStartup } from "./persistence";
import type { RelayEvent } from "./events";
import {
  bounds,
  flush,
  isNoticeRead,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const id = (n: number) => n.toString(16).padStart(64, "0");
function setup(maxWindows = 2, now = Date.now) {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const store = createRelaySession(scripted.transport, { maxWindows, now });
  return { ...scripted, store, queries: store.session.channels };
}

describe("channel store", () => {
  it("is unavailable without a transport and rejects bad capacity", () => {
    const store = createRelaySession(null);
    expect(store.session.channels.list().status).toBe("unavailable");
    store.session.channels.ensureList();
    store.session.channels.ensure("x");
    store.session.channels.loadOlder("x");
    expect(store.session.channels.window("x")).toMatchObject({
      status: "idle",
      rows: [],
    });
    expect(store.session.media("https://x.test/a.png")).toBeUndefined();
    expect(() => createRelaySession(null, { maxWindows: 0 })).toThrow();
  });
  it("loads the roster once, notifies list subscribers, and reports errors without losing state", async () => {
    // Roster and metadata phases have identical asOf values for this dedupe check.
    const { queries, next, pending } = setup(2, () => 1_000);
    const listener = vi.fn();
    queries.subscribeList(listener);
    queries.ensureList();
    queries.ensureList();
    expect(pending.length).toBe(1);
    expect(queries.list().status).toBe("loading");
    next().respond([
      roster(relay, "b", [viewer.pubkey]),
      metadata(relay, "b", "Beta"),
      roster(relay, "a", [alice.pubkey]),
    ]);
    await flush();
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "b", name: "Beta" }],
    });
    expect(listener).toHaveBeenCalledTimes(2);
    queries.ensureList();
    expect(pending.length).toBe(0);
    const failing = setup();
    failing.queries.ensureList();
    failing.next().fail(new Error("offline"));
    await flush();
    expect(failing.queries.list()).toMatchObject({
      status: "error",
      error: "offline",
    });
    failing.queries.ensureList();
    expect(failing.queries.list().status).toBe("loading");
  });
  it("does not republish the list when a channel lookup changes nothing", async () => {
    let clock = 0;
    const { queries, next } = setup(2, () => ++clock);
    queries.ensureList();
    next().respond([
      roster(relay, "b", [viewer.pubkey]),
      metadata(relay, "b", "Beta"),
    ]);
    await flush();
    // An open channel the viewer has not joined is looked up again on every
    // search or catch-up page that mentions it.
    const lookUp = async () => {
      const resolving = queries.resolve?.(["open"]);
      next().respond([metadata(relay, "open", "Open")]);
      await resolving;
    };
    await lookUp();
    const listener = vi.fn();
    queries.subscribeList(listener);
    const before = queries.list();
    await lookUp();
    expect(listener).not.toHaveBeenCalled();
    expect(queries.list()).toBe(before);
  });
  it("replaces a channel summary when only its private visibility changes", async () => {
    const { store, queries, next } = setup();
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    const publicSummary = queries.list().channels[0];
    expect(publicSummary?.private).toBeUndefined();

    queries.refreshList?.();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      signed(relay, {
        kind: 39000,
        content: JSON.stringify({ name: "Work" }),
        created_at: 1_700_000_001,
        tags: [["d", "work"], ["name", "Work"], ["private"]],
      }),
    ]);
    await flush();
    expect(queries.list().channels[0]).not.toBe(publicSummary);
    expect(queries.list().channels[0]?.private).toBe(true);
    store.dispose();
  });
  it("replaces a channel summary when only its auto-join flag changes", async () => {
    const { store, queries, next } = setup();
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    const plain = queries.list().channels[0];
    expect(plain?.autoJoin).toBeUndefined();

    queries.refreshList?.();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work", 1_700_000_001, [["auto_join"]]),
    ]);
    await flush();
    expect(queries.list().channels[0]).not.toBe(plain);
    expect(queries.list().channels[0]?.autoJoin).toBe(true);
    store.dispose();
  });
  it("preserves summary identity on preview refreshes and detects same-length DM roster changes", () => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { now: () => 1_000 },
    );
    try {
      const queries = owner.session.channels;
      live.receive([
        roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
        metadata(relay, "dm", "Direct", undefined, [["t", "dm"]]),
        roster(relay, "other", [viewer.pubkey]),
        metadata(relay, "other", "Other"),
      ]);
      const initial = queries.list().channels[0];
      const other = queries.list().channels[1];
      const listener = vi.fn();
      queries.subscribeList(listener);
      const incoming = message(alice, "dm", "hello", 10);
      live.receive([incoming]);
      const preview = queries.list();
      const direct = preview.channels[0];
      expect(direct).toMatchObject({ preview: "hello" });
      expect(direct?.members).toBe(initial?.members);
      expect(direct?.participants).toBe(initial?.participants);
      expect(preview.channels[1]).toBe(other);
      expect(listener).toHaveBeenCalledOnce();

      live.receive([incoming]);
      expect(queries.list()).toBe(preview);
      expect(listener).toHaveBeenCalledOnce();
      live.receive([
        roster(relay, "dm", [alice.pubkey, viewer.pubkey], 1_700_000_001),
      ]);
      expect(queries.list().channels[0]).toBe(direct);

      const replacement = keypair().pubkey;
      live.receive([
        roster(relay, "dm", [viewer.pubkey, replacement], 1_700_000_002),
      ]);
      expect(queries.list().channels[0]).not.toBe(direct);
      expect(queries.list().channels[0]).toMatchObject({
        preview: "hello",
        members: [viewer.pubkey, replacement].sort(),
        participants: [replacement],
      });
      expect(queries.list().channels[1]).toBe(other);
    } finally {
      owner.dispose();
    }
  });
  it("reads an older page of the asked size", async () => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    const queries = createRelaySession(scripted.transport).session.channels;
    queries.ensure("c");
    const newer = message(alice, "c", "newer", 20);
    scripted.next().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    const limits = [];
    let cursor = newer;
    for (const rows of [5, 120, 900]) {
      queries.loadOlder("c", rows);
      const page = scripted.pending.find(
        (read) => read.filters[0]?.until && !read.filters[0]?.include_aux,
      );
      assert(page);
      scripted.pending.splice(scripted.pending.indexOf(page), 1);
      limits.push(page.filters[0]?.limit);
      const older = message(alice, "c", `older ${rows}`, cursor.created_at - 1);
      page.respond([
        older,
        bounds(relay, "c", `${cursor.created_at}:${cursor.id}`, {
          has_more: true,
          next_cursor: { created_at: older.created_at, id: older.id },
        }),
      ]);
      cursor = older;
      await flush();
    }
    // The asked size, within the relay's read limit.
    expect(limits).toEqual([5, 120, 200]);
  });
  it("pages again after an older read is cancelled under the window", async () => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    const queries = createRelaySession(scripted.transport).session.channels;
    queries.ensure("c");
    const newer = message(alice, "c", "newer", 20);
    scripted.next().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    const older = () =>
      scripted.pending.find((read) => read.filters[0]?.until === 20);
    queries.loadOlder("c");
    const first = older();
    assert(first);
    scripted.pending.splice(scripted.pending.indexOf(first), 1);
    // A stream drop cancels every relay read, this page's included.
    first.fail(new DOMException("Relay read cancelled", "AbortError"));
    await flush();
    expect(queries.window("c").loadingOlder).toBe(false);
    queries.loadOlder("c");
    expect(older()).toBeDefined();
  });
  describe("an older page's aux closure", () => {
    const newer = message(alice, "c", "newer", 20);
    const row = (at: number) => message(alice, "c", `row ${at}`, at);
    const on = (kind: number, target: RelayEvent, content = "") =>
      signed(alice, {
        kind,
        content,
        created_at: 30,
        tags: [
          ["e", target.id],
          ["h", "c"],
        ],
      });
    const below = (cursor: RelayEvent, last?: RelayEvent) =>
      bounds(relay, "c", `${cursor.created_at}:${cursor.id}`, {
        has_more: !!last,
        next_cursor: last ? { created_at: last.created_at, id: last.id } : null,
      });
    async function opened(budget = {}, whileHeadReads?: RelayEvent) {
      const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
      let live!: LiveCallbacks;
      const store = createRelaySession(
        {
          ...scripted.transport,
          subscribe(callbacks) {
            live = callbacks;
            return { update() {}, retry() {}, dispose() {} };
          },
        },
        budget,
      );
      const queries = store.session.channels;
      live.receive([roster(relay, "c", [viewer.pubkey])]);
      queries.ensure("c");
      if (whileHeadReads) live.receive([whileHeadReads]);
      scripted.next().respond([
        newer,
        bounds(relay, "c", "head", {
          has_more: true,
          next_cursor: { created_at: 20, id: newer.id },
        }),
      ]);
      await flush();
      const take = (aux: boolean) => {
        const read = scripted.pending.find(
          (entry) =>
            !!entry.filters[0]?.until &&
            !!entry.filters[0]?.include_aux === aux,
        );
        assert(read);
        scripted.pending.splice(scripted.pending.indexOf(read), 1);
        return read;
      };
      /** Page once, below `cursor`, to `rows` shown bare. */
      const page = async (cursor: RelayEvent, ...rows: RelayEvent[]) => {
        queries.loadOlder("c");
        take(false).respond([...rows, below(cursor, rows[0])]);
        await flush();
      };
      return { queries, take, page, scripted, store, live };
    }
    it("withdraws a held edit its aux read deletes", async () => {
      const { queries, take, page } = await opened();
      const target = row(10);
      const edit = on(40003, target, "edited");
      await page(newer, target, edit);
      expect(queries.window("c").rows[0]?.content).toBe("edited");
      take(true).respond([target, edit, on(5, edit), below(newer)]);
      await flush();
      expect(queries.window("c").rows[0]?.content).toBe("row 10");
    });
    it("reads a page's aux only once its channel is open again", async () => {
      const { queries, take, scripted } = await opened();
      const first = row(10);
      queries.loadOlder("c");
      queries.ensure("d");
      take(false).respond([first, below(newer, first)]);
      await flush();
      expect(
        scripted.pending.some(
          (read) => read.filters[0]?.until && read.filters[0]?.include_aux,
        ),
      ).toBe(false);
      queries.ensure("c");
      expect(take(true).filters[0]).toMatchObject({ until: 20 });
    });
    it("reads a page too large for a response again in default pages", async () => {
      const { queries, take } = await opened();
      queries.loadOlder("c", 200);
      const large = take(false);
      expect(large.filters[0]).toMatchObject({ limit: 200, until: 20 });
      large.fail(
        new ReadError(
          "invalid-response",
          "Relay response exceeds the read budget",
        ),
      );
      await flush();
      expect(take(false).filters[0]).toMatchObject({ limit: 20, until: 20 });
      expect(queries.window("c")).toMatchObject({
        loadingOlder: true,
        error: undefined,
      });
    });
    it("ends a newer page a stream drop cancels", async () => {
      const { queries, page, scripted } = await opened({ maxHistoryRows: 2 });
      const [a, b, c] = [row(10), row(8), row(6)];
      await page(newer, a);
      await page(a, b);
      await page(b, c);
      expect(queries.window("c").hasNewer).toBe(true);
      const before = new Set(scripted.pending);
      queries.loadNewer?.("c");
      expect(queries.window("c").loadingNewer).toBe(true);
      const read = scripted.pending.find((entry) => !before.has(entry));
      assert(read);
      read.fail(new DOMException("Relay read cancelled", "AbortError"));
      await flush();
      expect(queries.window("c").loadingNewer).toBeFalsy();
    });
    it("reads a closure too large for a response again in smaller parts", async () => {
      const { take, page } = await opened();
      await page(newer, row(10), row(9), row(8));
      const large = take(true);
      expect(large.filters[0]).toMatchObject({ limit: 3, until: 20 });
      large.fail(
        new ReadError(
          "invalid-response",
          "Relay response exceeds the read budget",
        ),
      );
      await flush();
      expect(take(true).filters[0]).toMatchObject({ limit: 2, until: 20 });
    });
    it("reads past a failing aux page to the pages behind it", async () => {
      const { take, page } = await opened();
      const [a, b] = [row(10), row(8)];
      await page(newer, a);
      const failing = take(true);
      await page(a, b);
      // One row's closure past the response budget: it reads no smaller.
      failing.fail(
        new ReadError(
          "invalid-response",
          "Relay response exceeds the read budget",
        ),
      );
      await flush();
      // The same fill reads the page behind it.
      expect(take(true).filters[0]).toMatchObject({ until: a.created_at });
    });
    it("an aux slide forgets the live rows it drops", async () => {
      const late = message(alice, "c", "late", 25);
      const target = row(10);
      const edit = on(40003, target, "edited");
      const { queries, take, page, scripted, live } = await opened({
        maxHistoryBytes: listByteSize([newer, late, target, edit]) - 1,
      });
      live.receive([late]);
      await flush();
      await page(newer, target);
      take(true).respond([target, edit, below(newer)]);
      await flush();
      // The slide drops the live row for the rows paged to.
      expect(queries.window("c").hasNewer).toBe(true);
      expect(queries.window("c").rows.map((row) => row.content)).toEqual([
        "edited",
        "newer",
      ]);
      // A head without the live row (deleted meanwhile) shows only its own.
      queries.attach?.("c");
      const head = scripted.pending.find(
        (read) => read.filters[0]?.top_level && !read.filters[0]?.until,
      );
      head?.respond([
        newer,
        bounds(relay, "c", "head", {
          has_more: true,
          next_cursor: { created_at: 20, id: newer.id },
        }),
      ]);
      await flush();
      expect(queries.window("c").rows.map((row) => row.id)).toEqual([newer.id]);
    });
    it("drops a read-ahead page past the budget and stays at the head", async () => {
      const target = row(10);
      const { queries, take, scripted } = await opened({
        maxHistoryBytes: listByteSize([newer, target]) - 1,
      });
      queries.loadOlder("c", 20, true);
      take(false).respond([target, below(newer, target)]);
      await flush();
      expect(queries.window("c")).toMatchObject({
        loadingOlder: false,
        rows: [{ id: newer.id }],
      });
      expect(queries.window("c").hasNewer).toBeFalsy();
      // Read-ahead stops; the reader's own paging still reads.
      queries.loadOlder("c", 20, true);
      expect(scripted.pending.some((read) => read.filters[0]?.until)).toBe(
        false,
      );
      queries.loadOlder("c");
      expect(take(false).filters[0]).toMatchObject({ until: 20 });
    });
    it("trims a read-ahead page's closure past the budget at the head", async () => {
      const target = row(10);
      const edit = on(40003, target, "edited");
      const { queries, take } = await opened({
        maxHistoryBytes: listByteSize([newer, target, edit]) - 1,
      });
      queries.loadOlder("c", 20, true);
      take(false).respond([target, below(newer, target)]);
      await flush();
      take(true).respond([target, edit, below(newer)]);
      await flush();
      expect(queries.window("c").hasNewer).toBeFalsy();
      expect(queries.window("c").rows.map((row) => row.id)).toEqual([newer.id]);
    });
    it("a read-ahead closure trim forgets the live rows it drops", async () => {
      const target = row(10);
      const edit = on(40003, target, "edited");
      // A late send in the oldest second, sorting below the row paged to.
      let late = message(alice, "c", "late", 10);
      for (let n = 0; late.id < target.id; n++)
        late = message(alice, "c", `late ${n}`, 10);
      const { queries, take, live, scripted } = await opened({
        maxHistoryBytes: listByteSize([newer, late, target, edit]) - 1,
      });
      queries.loadOlder("c", 20, true);
      take(false).respond([target, below(newer, target)]);
      await flush();
      live.receive([late]);
      await flush();
      expect(queries.window("c").rows.map((row) => row.id)).toContain(late.id);
      take(true).respond([target, edit, below(newer)]);
      await flush();
      expect(queries.window("c").rows.map((row) => row.id)).not.toContain(
        late.id,
      );
      // Nor does a head that meets the rows held.
      queries.refresh?.("c");
      for (const read of scripted.pending.filter(
        (entry) => entry.filters[0]?.top_level && !entry.filters[0]?.until,
      ))
        read.respond([
          newer,
          target,
          bounds(relay, "c", "head", {
            has_more: true,
            next_cursor: { created_at: 10, id: target.id },
          }),
        ]);
      await flush();
      expect(queries.window("c").rows.map((row) => row.id)).not.toContain(
        late.id,
      );
    });
    it("keeps a live row from the head read when aux merges", async () => {
      const late = message(alice, "c", "late", 25);
      const { queries, take, page } = await opened({}, late);
      const target = row(10);
      await page(newer, target);
      take(true).respond([target, on(7, target, "+"), below(newer)]);
      await flush();
      expect(queries.window("c").rows.map((row) => row.content)).toEqual([
        "row 10",
        "newer",
        "late",
      ]);
    });
    it("reads a cancelled aux read again with the next fill", async () => {
      const { take, page } = await opened();
      const first = row(10);
      await page(newer, first);
      // A stream drop cancels every relay read, this aux read's included.
      take(true).fail(new DOMException("Relay read cancelled", "AbortError"));
      await flush();
      await page(first, row(8));
      expect(take(true).filters[0]).toMatchObject({ until: 20 });
    });
    it("slides an aux closure past the budget down to the rows paged to", async () => {
      const target = row(10);
      const edit = on(40003, target, "edited");
      const { queries, take, page } = await opened({
        maxHistoryBytes: listByteSize([newer, target, edit]) - 1,
      });
      await page(newer, target);
      take(true).respond([target, edit, below(newer)]);
      await flush();
      const window = queries.window("c");
      expect(window).toMatchObject({
        hasNewer: true,
        rows: [{ id: target.id, content: "edited" }],
      });
      expect(window?.historyLimited).toBeFalsy();
      // The next older page slides on within the budget.
      const older = row(8);
      await page(target, older);
      expect(queries.window("c")).toMatchObject({
        hasNewer: true,
        rows: [{ id: older.id }, { id: target.id, content: "edited" }],
      });
    });
    it("applies an aux closure larger than the whole budget", async () => {
      const target = row(10);
      const edit = on(40003, target, "edited");
      const { queries, take, page } = await opened({
        maxHistoryBytes: listByteSize([target, edit]) - 1,
      });
      await page(newer, target);
      expect(queries.window("c").historyLimited).toBeFalsy();
      take(true).respond([target, edit, below(newer)]);
      await flush();
      expect(queries.window("c")).toMatchObject({
        rows: [{ id: target.id, content: "edited" }, { id: newer.id }],
      });
    });
    it("does not slide to rows an aux closure deletes", async () => {
      const [a, b] = [row(10), row(8)];
      const edit = on(40003, a, "edited ".repeat(200));
      const { queries, take, page } = await opened({
        maxHistoryBytes: listByteSize([newer, a, b]) + 400,
      });
      await page(newer, a, b);
      take(true).respond([a, b, edit, on(5, b), below(newer)]);
      await flush();
      expect(queries.window("c")).toMatchObject({
        rows: [{ id: a.id, content: edit.content }, { id: newer.id }],
      });
    });
    it("skips the aux read of a page the window has slid past", async () => {
      const { queries, take, page, scripted } = await opened({
        maxHistoryRows: 2,
      });
      const [a, b, c, d] = [row(10), row(8), row(6), row(4)];
      await page(newer, a);
      const held = take(true);
      await page(a, b);
      await page(b, c);
      await page(c, d);
      // The window holds c and d: b's page is gone, c's is next.
      held.respond([a, below(newer)]);
      await flush();
      // The dropped row stays dropped.
      expect(queries.window("c")).toMatchObject({
        hasNewer: true,
        rows: [{ id: d.id }, { id: c.id }],
      });
      expect(take(true).filters[0]).toMatchObject({ until: b.created_at });
      // Newer history reads up from b, the newest row slid past: a day above
      // the ceiling (history-seek), not above the row the late aux held.
      queries.loadNewer?.("c");
      const newerRead = scripted.pending.find((read) =>
        read.filters[0]?.["#h"]?.includes("c"),
      );
      expect(newerRead?.filters[0]?.until).toBe(b.created_at + 86_400);
    });
    it("keeps a row live traffic drops out while its aux read is in flight", async () => {
      const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
      let live!: LiveCallbacks;
      const queries = createRelaySession(
        {
          ...scripted.transport,
          subscribe(callbacks) {
            live = callbacks;
            return { update() {}, retry() {}, dispose() {} };
          },
        },
        { maxHistoryRows: 3 },
      ).session.channels;
      live.receive([roster(relay, "c", [viewer.pubkey])]);
      queries.ensure("c");
      scripted.next().respond([
        newer,
        bounds(relay, "c", "head", {
          has_more: true,
          next_cursor: { created_at: 20, id: newer.id },
        }),
      ]);
      await flush();
      const [a, b] = [row(10), row(8)];
      queries.loadOlder("c");
      const bare = scripted.pending.find((read) => read.filters[0]?.until);
      assert(bare);
      bare.respond([a, b, below(newer, b)]);
      await flush();
      const held = scripted.pending.find(
        (read) => read.filters[0]?.include_aux,
      );
      assert(held);
      const fresh = message(alice, "c", "fresh", 25);
      live.receive([fresh]);
      held.respond([a, b, below(newer)]);
      await flush();
      // The window stays at the head, without the dropped row.
      expect(queries.window("c").hasNewer).toBeFalsy();
      expect(queries.window("c").rows.map((row) => row.id)).toEqual([
        a.id,
        newer.id,
        fresh.id,
      ]);
    });
    it.each([false, true])(
      "reads an aux read an access purge cancels again (resolved first: %s)",
      async (resolved) => {
        const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
        const queries = createRelaySession(scripted.transport).session.channels;
        queries.ensure("c");
        scripted.next().respond([
          newer,
          bounds(relay, "c", "head", {
            has_more: true,
            next_cursor: { created_at: 20, id: newer.id },
          }),
        ]);
        await flush();
        queries.loadOlder("c");
        const bare = scripted.pending.find((read) => read.filters[0]?.until);
        assert(bare);
        bare.respond([row(10), below(newer)]);
        await flush();
        const auxRead = () =>
          scripted.pending.find(
            (read) => read.filters[0]?.include_aux && read.filters[0]?.until,
          );
        const held = auxRead();
        assert(held);
        scripted.pending.splice(scripted.pending.indexOf(held), 1);
        if (resolved) held.respond([below(newer)]);
        // Another channel's denied head read purges access everywhere.
        queries.ensure("x");
        const other = scripted.pending.find((read) =>
          read.filters[0]?.["#h"]?.includes("x"),
        );
        assert(other);
        other.fail(new ReadError("denied", "Forbidden", 403));
        await flush();
        // Opening the other channel paused the aux work; returning resumes it.
        queries.ensure("c");
        expect(auxRead()?.filters[0]).toMatchObject({ until: 20 });
      },
    );
    it("reads a refused aux read again when its retry hint expires", async () => {
      const { queries, take, page } = await opened();
      await page(newer, row(10));
      vi.useFakeTimers({
        toFake: ["performance", "setTimeout", "clearTimeout"],
      });
      try {
        // A fractional hint: the timer fires at whole milliseconds.
        take(true).fail(new ReadError("unavailable", "Quota", 429, 60_000.6));
        await vi.advanceTimersByTimeAsync(0);
        queries.ensure("c");
        expect(() => take(true), "no aux read inside the hint").toThrow();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(take(true).filters[0]).toMatchObject({ until: 20 });
      } finally {
        vi.useRealTimers();
      }
    });
    it("cancels a refused aux read's retry when the session is disposed", async () => {
      const { take, page, store } = await opened();
      await page(newer, row(10));
      vi.useFakeTimers({
        toFake: ["performance", "setTimeout", "clearTimeout"],
      });
      try {
        take(true).fail(new ReadError("unavailable", "Quota", 429, 60_000));
        await vi.advanceTimersByTimeAsync(0);
        store.dispose();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(() => take(true), "no aux read after disposal").toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
    it("reads a failed aux read again when the channel is revisited", async () => {
      const { queries, take, page } = await opened();
      await page(newer, row(10));
      take(true).fail(new Error("denied"));
      await flush();
      queries.ensure("c");
      expect(take(true).filters[0]).toMatchObject({ until: 20 });
    });
    it("cancels an aux read when another channel opens and reads it again on return", async () => {
      const { queries, take, page, scripted } = await opened();
      await page(newer, row(10));
      const held = take(true);
      queries.ensure("d");
      expect(held.signal?.aborted).toBe(true);
      await flush();
      scripted.pending.length = 0;
      queries.ensure("c");
      expect(take(true).filters[0]).toMatchObject({ until: 20 });
    });
    async function revisited(head: RelayEvent[]) {
      let clock = 1_000_000;
      const { queries, take, page, scripted } = await opened({
        prepared: true,
        now: () => clock,
      });
      const older = row(10);
      await page(newer, older);
      take(true).respond([older, below(newer)]);
      await flush();
      queries.ensure("d");
      await flush();
      scripted.pending.length = 0;
      clock += 61_000;
      const query = vi.spyOn(scripted.transport, "query");
      queries.ensure("c");
      const last = head.at(-1);
      assert(last);
      const read = scripted.next();
      read.respond([
        ...head,
        bounds(relay, "c", "head", {
          has_more: true,
          next_cursor: { created_at: last.created_at, id: last.id },
        }),
      ]);
      await flush();
      return {
        ids: queries.window("c").rows.map((row) => row.id),
        older,
        read,
        noticeReads: query.mock.calls.filter(([filters]) =>
          isNoticeRead(filters),
        ).length,
      };
    }
    const latest = message(alice, "c", "latest", 25);
    it("merges a newer head into the paged rows on a revisit past the lease", async () => {
      const { ids, older, read, noticeReads } = await revisited([
        latest,
        newer,
      ]);
      expect(ids).toEqual([older.id, newer.id, latest.id]);
      // The head read its newest notices, so none are read apart from it.
      expect(read.filters[1]).toMatchObject({ kinds: [40099] });
      expect(noticeReads).toBe(0);
    });
    it("replaces the paged rows with a newer head that does not meet them", async () => {
      const after = message(alice, "c", "after", 24);
      expect(await revisited([latest, after])).toMatchObject({
        ids: [after.id, latest.id],
      });
    });
    it("a failed return to the head keeps the aux work of the rows it shows", async () => {
      const { queries, take, page, scripted } = await opened({
        maxHistoryRows: 2,
      });
      const [a, b] = [row(10), row(8)];
      await page(newer, a);
      const held = take(true);
      await page(a, b);
      expect(queries.window("c").hasNewer).toBe(true);
      queries.attach?.("c");
      expect(held.signal?.aborted).toBe(true);
      await flush();
      // No aux read while the head loads.
      expect(
        scripted.pending.some(
          (read) => read.filters[0]?.include_aux && read.filters[0]?.until,
        ),
      ).toBe(false);
      const head = scripted.pending.find(
        (read) => !read.filters[0]?.until && read.filters[0]?.["#h"],
      );
      assert(head);
      scripted.pending.splice(scripted.pending.indexOf(head), 1);
      head.fail(new ReadError("unavailable", "Relay is down"));
      await flush();
      expect(queries.window("c").hasNewer).toBe(true);
      expect(take(true).filters[0]).toMatchObject({ until: 20 });
    });
    it("returning to the head ends the aux work of the rows it replaces", async () => {
      const { queries, take, page, scripted } = await opened({
        maxHistoryRows: 2,
      });
      const [a, b] = [row(10), row(8)];
      await page(newer, a);
      const held = take(true);
      await page(a, b);
      expect(queries.window("c").hasNewer).toBe(true);
      queries.attach?.("c");
      expect(held.signal?.aborted).toBe(true);
      // The cancelled read is not read again: paging once reads one aux part.
      const head = scripted.pending.find(
        (read) => !read.filters[0]?.until && read.filters[0]?.["#h"],
      );
      assert(head);
      scripted.pending.splice(scripted.pending.indexOf(head), 1);
      head.respond([
        newer,
        bounds(relay, "c", "head", {
          has_more: true,
          next_cursor: { created_at: 20, id: newer.id },
        }),
      ]);
      await flush();
      await page(newer, a);
      take(true).respond([a, below(newer)]);
      await flush();
      expect(
        scripted.pending.filter((read) => read.filters[0]?.include_aux),
      ).toEqual([]);
    });
  });
  // 40 held rows at 1000..961, two of them sharing 981, and an older page of
  // 40 rows at 960..921.
  const held = Array.from({ length: 40 }, (_, i) =>
    message(alice, "c", `held ${i}`, i === 18 ? 981 : 1000 - i),
  );
  const older = Array.from({ length: 40 }, (_, i) =>
    message(alice, "c", `older ${i}`, 960 - i),
  );
  // A withdrawn edit and a removed reaction on the two newest older rows.
  const about = (kind: number, target: RelayEvent, content = "") =>
    signed(alice, {
      kind,
      content,
      created_at: 999,
      tags: [
        ["e", target.id],
        ["h", "c"],
      ],
    });
  const edit = about(40003, older[0] as RelayEvent, "withdrawn edit");
  const reaction = about(7, older[1] as RelayEvent, "👍");
  const aux = [edit, about(5, edit), reaction, about(5, reaction)];
  // The page and the 20 oldest held rows: the 21st shares its second with the
  // 22nd, which the budget leaves out.
  const kept = [...older, ...held.filter((row) => row.created_at < 981)];
  const notices = Array.from({ length: 150 }, (_, i) =>
    signed(relay, {
      kind: 40099,
      content: JSON.stringify({
        type: "member_joined",
        actor: alice.pubkey,
        target: keypair().pubkey,
      }),
      created_at: 1001 + i,
      tags: [["h", "c"]],
    }),
  );
  it.each([
    [
      "byte",
      0,
      {
        maxHistoryBytes: listByteSize([
          ...kept,
          ...aux,
          held[18] as RelayEvent,
        ]),
      },
    ],
    ["row", 0, { maxHistoryRows: 61 }],
    ["row", notices.length, { maxHistoryRows: 61 }],
  ])(
    "an older page past the %s budget, with %i notices shown, slides the window down to it",
    async (_, shown, budget) => {
      const scripted = scriptedTransport(viewer.pubkey, relay.pubkey, {
        notices: true,
      });
      const queries = createRelaySession(scripted.transport, budget).session
        .channels;
      queries.ensure("c");
      const last = held[39] as RelayEvent;
      scripted.next().respond([
        ...held,
        bounds(relay, "c", "head", {
          has_more: true,
          next_cursor: { created_at: last.created_at, id: last.id },
        }),
      ]);
      await flush();
      scripted.next().respond(notices.slice(0, shown));
      await flush();
      expect(queries.window("c").rows).toHaveLength(40 + shown);
      queries.loadOlder("c", 200);
      const page = scripted.pending.find((read) => read.filters[0]?.until);
      assert(page);
      const oldest = older[39] as RelayEvent;
      page.respond([
        ...older,
        ...aux,
        bounds(relay, "c", `${last.created_at}:${last.id}`, {
          has_more: true,
          next_cursor: { created_at: oldest.created_at, id: oldest.id },
        }),
      ]);
      await flush();
      const window = queries.window("c");
      expect(window).toMatchObject({
        status: "ready",
        hasMore: true,
        hasNewer: true,
        loadingOlder: false,
      });
      expect(window.historyLimited).toBeFalsy();
      expect(window.rows.map((row) => row.id)).toEqual(
        kept
          .sort((a, b) => a.created_at - b.created_at)
          .map((event) => event.id),
      );
      // The withdrawn edit and removed reaction stay withdrawn.
      const row = (event?: RelayEvent) =>
        window.rows.find((item) => item.id === event?.id);
      expect(row(older[0])?.content).toBe("older 0");
      expect(row(older[1])?.reactions).toEqual([]);
    },
  );
  it("replaces paged rows with a revisit head that meets only their live tail", async () => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    let clock = 1_000_000;
    const queries = createRelaySession(
      {
        ...scripted.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { prepared: true, now: () => clock },
    ).session.channels;
    live.receive([roster(relay, "c", [viewer.pubkey])]);
    queries.ensure("c");
    const [older, head, stray, tail, latest] = [5, 10, 20, 30, 40].map((at) =>
      message(alice, "c", `at ${at}`, at),
    );
    assert(older && head && stray && tail && latest);
    const take = () => {
      const read = scripted.pending.find(
        (entry) =>
          entry.filters[0]?.top_level && !entry.filters[0]?.include_aux,
      );
      assert(read);
      scripted.pending.splice(scripted.pending.indexOf(read), 1);
      return read;
    };
    scripted.next().respond([
      head,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 10, id: head.id },
      }),
    ]);
    await flush();
    queries.loadOlder("c");
    take().respond([
      older,
      bounds(relay, "c", `10:${head.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    // The stream delivers a row; what it missed before it is unknown.
    live.receive([stray, tail]);
    queries.ensure("d");
    await flush();
    scripted.pending.length = 0;
    clock += 61_000;
    queries.ensure("c");
    const revisit = scripted.pending.find(
      (entry) => entry.filters[0]?.top_level && !entry.filters[0]?.until,
    );
    assert(revisit);
    revisit.respond([
      latest,
      tail,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 30, id: tail.id },
      }),
    ]);
    await flush();
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([
      tail.id,
      latest.id,
    ]);
  });
  it("a revisit head drops live rows below its cursor in the cursor's second", async () => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    let clock = 1_000_000;
    const queries = createRelaySession(
      {
        ...scripted.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { prepared: true, now: () => clock },
    ).session.channels;
    live.receive([roster(relay, "c", [viewer.pubkey])]);
    queries.ensure("c");
    const [older, head, latest] = [5, 10, 40].map((at) =>
      message(alice, "c", `at ${at}`, at),
    );
    // Relay order at a tie is ID ascending: `after` sorts below the cursor.
    const [tail, after] = ["a", "c"]
      .map((name) => message(alice, "c", name, 30))
      .sort((a, b) => a.id.localeCompare(b.id));
    assert(older && head && latest && tail && after);
    scripted.next().respond([
      head,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 10, id: head.id },
      }),
    ]);
    await flush();
    queries.loadOlder("c");
    const page = scripted.pending.find(
      (entry) => entry.filters[0]?.until && !entry.filters[0]?.include_aux,
    );
    assert(page);
    scripted.pending.splice(scripted.pending.indexOf(page), 1);
    page.respond([
      older,
      bounds(relay, "c", `10:${head.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    live.receive([tail, after]);
    queries.ensure("d");
    await flush();
    scripted.pending.length = 0;
    clock += 61_000;
    queries.ensure("c");
    const revisit = scripted.pending.find(
      (entry) => entry.filters[0]?.top_level && !entry.filters[0]?.until,
    );
    assert(revisit);
    revisit.respond([
      latest,
      tail,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 30, id: tail.id },
      }),
    ]);
    await flush();
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([
      tail.id,
      latest.id,
    ]);
  });
  it("a live trim of late rows below the floor keeps the older cursor", async () => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const head = message(alice, "c", "head", 30);
    const [ten, five] = [
      message(alice, "c", "ten", 10),
      message(alice, "c", "five", 5),
    ];
    const queries = createRelaySession(
      {
        ...scripted.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { maxHistoryBytes: listByteSize([head, ten]) },
    ).session.channels;
    live.receive([roster(relay, "c", [viewer.pubkey])]);
    queries.ensure("c");
    scripted.next().respond([
      head,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 30, id: head.id },
      }),
    ]);
    await flush();
    live.receive([ten, five]);
    await flush();
    queries.loadOlder("c");
    expect(
      scripted.pending.find((read) => read.filters[0]?.until)?.filters[0],
    ).toMatchObject({ until: 30, before_id: head.id });
  });
  it("a live trim keeps the older cursor for rows below it in the cursor's second", async () => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    // The relay orders a second's rows by ID: the head read ends at `head`.
    const [head, unseen, liveA, liveB] = ["a", "b", "c", "d"]
      .map((name) => message(alice, "c", name, 30))
      .sort((a, b) => a.id.localeCompare(b.id));
    assert(head && unseen && liveA && liveB);
    const queries = createRelaySession(
      {
        ...scripted.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { maxHistoryBytes: listByteSize([head, liveA]) },
    ).session.channels;
    live.receive([roster(relay, "c", [viewer.pubkey])]);
    queries.ensure("c");
    scripted.next().respond([
      head,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 30, id: head.id },
      }),
    ]);
    await flush();
    live.receive([liveA, liveB]);
    await flush();
    queries.loadOlder("c");
    expect(
      scripted.pending.find((read) => read.filters[0]?.until)?.filters[0],
    ).toMatchObject({ until: 30, before_id: head.id });
  });
  it("a full window drops its oldest rows for live traffic, but not under an older read", async () => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const queries = createRelaySession(
      {
        ...scripted.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { maxHistoryRows: 2 },
    ).session.channels;
    live.receive([roster(relay, "c", [viewer.pubkey])]);
    queries.ensure("c");
    const one = message(alice, "c", "one", 1);
    const two = message(alice, "c", "two", 2);
    scripted.next().respond([
      two,
      one,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 1, id: one.id },
      }),
    ]);
    await flush();
    const three = message(alice, "c", "three", 3);
    live.receive([three]);
    expect(queries.window("c")).toMatchObject({ hasMore: true });
    expect(queries.window("c").rows.map((row) => row.content)).toEqual([
      "two",
      "three",
    ]);
    // The next older page reads the dropped row again; traffic while it is
    // in flight does not cancel it.
    await flush();
    queries.loadOlder("c");
    const older = scripted.pending.find((read) => read.filters[0]?.until);
    expect(older?.filters[0]).toMatchObject({ until: 2, before_id: two.id });
    live.receive([message(alice, "c", "four", 4)]);
    expect(older?.signal?.aborted).toBe(false);
    older?.respond([
      one,
      bounds(relay, "c", `2:${two.id}`, { has_more: false, next_cursor: null }),
    ]);
    await flush();
    // It lands below the rows held and slides the window within its budget.
    expect(queries.window("c")).toMatchObject({
      hasNewer: true,
      loadingOlder: false,
    });
    expect(queries.window("c").rows.map((row) => row.content)).toEqual([
      "one",
      "two",
    ]);
    // The slide forgets the live row it dropped: a head without it (deleted
    // meanwhile) shows only its own rows.
    queries.attach?.("c");
    const head = scripted.pending.find(
      (read) => read.filters[0]?.top_level && !read.filters[0]?.until,
    );
    head?.respond([
      three,
      two,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 2, id: two.id },
      }),
    ]);
    await flush();
    expect(queries.window("c").rows.map((row) => row.content)).toEqual([
      "two",
      "three",
    ]);
  });
  it("pages a window by the relay cursor, prepends older rows, and fetches missing profiles once", async () => {
    const { store, queries, next, pending } = setup();
    const listener = vi.fn();
    queries.subscribeWindow("c", listener);
    queries.ensure("c");
    queries.ensure("c");
    expect(pending.length).toBe(1);
    expect(queries.window("c").status).toBe("loading");
    const newer = message(alice, "c", "newer", 20),
      older = message(alice, "c", "older", 10);
    const head = next();
    expect(head.filters[0]).toMatchObject({
      "#h": ["c"],
      top_level: true,
      include_aux: true,
      include_summaries: true,
      limit: 20,
    });
    head.respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      hasMore: true,
      loadingOlder: false,
      rows: [{ id: newer.id }],
    });
    const profiles = next();
    expect(profiles.filters[0]).toMatchObject({
      kinds: [0],
      authors: [alice.pubkey],
    });
    queries.loadOlder("c");
    queries.loadOlder("c");
    expect(pending.length).toBe(1);
    expect(queries.window("c").loadingOlder).toBe(true);
    const page = next();
    expect(page.filters[0]).toMatchObject({
      until: 20,
      before_id: newer.id,
      top_level: true,
      include_summaries: true,
      limit: 20,
    });
    expect(page.filters[0]).not.toHaveProperty("include_aux");
    // Older rows prepend; the duplicated `newer` row is deduped; alice is already pending so no second profile query.
    page.respond([
      older,
      newer,
      bounds(relay, "c", `20:${newer.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      rows: [{ id: older.id }, { id: newer.id }],
    });
    // The same page then reads in full, adding its aux closure to the rows:
    // as many rows as it showed.
    const aux = next();
    expect(aux.filters[0]).toMatchObject({
      until: 20,
      before_id: newer.id,
      include_aux: true,
      limit: 2,
    });
    expect(aux.filters[0]).not.toHaveProperty("include_summaries");
    aux.respond([
      older,
      newer,
      signed(viewer, {
        kind: 7,
        content: "+",
        created_at: 11,
        tags: [
          ["h", "c"],
          ["e", older.id],
        ],
      }),
      bounds(relay, "c", `20:${newer.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(queries.window("c").rows[0]?.reactions).toMatchObject([
      { content: "+" },
    ]);
    expect(pending.length).toBe(0);
    profiles.respond([profile(alice, { name: "Alice" })]);
    await flush();
    expect(store.session.profiles.snapshot().get(alice.pubkey)).toEqual({
      name: "Alice",
    });
    queries.loadOlder("c");
    expect(pending.length).toBe(0);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it("cancelling an older read aborts it and leaves the window to read it again", async () => {
    const { queries, next, pending } = setup();
    queries.ensure("c");
    const newer = message(alice, "c", "newer", 20);
    next().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    queries.loadOlder("c", 200);
    const page = pending.find((read) => read.filters[0]?.until);
    assert(page);
    queries.cancelOlder?.("c");
    expect(page.signal?.aborted).toBe(true);
    expect(queries.window("c")).toMatchObject({
      loadingOlder: false,
      hasMore: true,
      error: undefined,
      rows: [{ id: newer.id }],
    });
    await flush();
    queries.loadOlder("c");
    expect(pending.at(-1)?.filters[0]).toMatchObject({
      until: 20,
      before_id: newer.id,
    });
  });
  it("reads a large page's aux closure in 50-row parts by the relay cursor", async () => {
    const { queries, pending } = setup();
    queries.ensure("c");
    const newer = message(alice, "c", "newer", 200);
    const take = () => {
      const read = pending.find((entry) => entry.filters[0]?.top_level);
      assert(read);
      pending.splice(pending.indexOf(read), 1);
      return read;
    };
    take().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 200, id: newer.id },
      }),
    ]);
    await flush();
    queries.loadOlder("c", 120);
    const page = take();
    expect(page.filters[0]).toMatchObject({ limit: 120 });
    expect(page.filters[0]).not.toHaveProperty("include_aux");
    const rows = Array.from({ length: 120 }, (_, n) =>
      message(alice, "c", `older ${n}`, 199 - n),
    );
    const last = rows.at(-1);
    assert(last);
    page.respond([
      ...rows,
      bounds(relay, "c", `200:${newer.id}`, {
        has_more: true,
        next_cursor: { created_at: last.created_at, id: last.id },
      }),
    ]);
    await flush();
    const parts = [];
    let cursor = newer;
    for (const size of [50, 50, 20]) {
      const aux = take();
      parts.push(aux.filters[0]);
      const part = rows.slice(
        rows.indexOf(cursor) + 1,
        rows.indexOf(cursor) + 1 + size,
      );
      const end = part.at(-1);
      assert(end);
      aux.respond([
        ...part,
        bounds(relay, "c", `${cursor.created_at}:${cursor.id}`, {
          has_more: true,
          next_cursor: { created_at: end.created_at, id: end.id },
        }),
      ]);
      cursor = end;
      await flush();
    }
    expect(parts).toMatchObject([
      { include_aux: true, limit: 50, until: 200 },
      { include_aux: true, limit: 50, until: rows[49]?.created_at },
      { include_aux: true, limit: 20, until: rows[99]?.created_at },
    ]);
    expect(pending.filter((entry) => entry.filters[0]?.top_level)).toEqual([]);
  });
  it("reads on past a row written into a page's range until its aux covers every row", async () => {
    const { queries, pending } = setup();
    queries.ensure("c");
    const newer = message(alice, "c", "newer", 200);
    const take = () => {
      const read = pending.find((entry) => entry.filters[0]?.top_level);
      assert(read);
      pending.splice(pending.indexOf(read), 1);
      return read;
    };
    take().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 200, id: newer.id },
      }),
    ]);
    await flush();
    queries.loadOlder("c");
    const rows = [190, 180, 170].map((at) =>
      message(alice, "c", `older ${at}`, at),
    );
    const [first, second, last] = rows;
    assert(first && second && last);
    take().respond([
      ...rows,
      bounds(relay, "c", `200:${newer.id}`, {
        has_more: true,
        next_cursor: { created_at: last.created_at, id: last.id },
      }),
    ]);
    await flush();
    // A backdated row takes a place in the limited aux read.
    const backdated = message(alice, "c", "backdated", 175);
    const aux = take();
    expect(aux.filters[0]).toMatchObject({ include_aux: true, limit: 3 });
    aux.respond([
      first,
      second,
      backdated,
      bounds(relay, "c", `200:${newer.id}`, {
        has_more: true,
        next_cursor: { created_at: backdated.created_at, id: backdated.id },
      }),
    ]);
    await flush();
    const rest = take();
    expect(rest.filters[0]).toMatchObject({
      include_aux: true,
      limit: 1,
      until: backdated.created_at,
      before_id: backdated.id,
    });
    const reaction = signed(viewer, {
      kind: 7,
      content: "+",
      created_at: 171,
      tags: [
        ["h", "c"],
        ["e", last.id],
      ],
    });
    rest.respond([
      last,
      reaction,
      bounds(relay, "c", `175:${backdated.id}`, {
        has_more: true,
        next_cursor: { created_at: last.created_at, id: last.id },
      }),
    ]);
    await flush();
    expect(
      queries.window("c").rows.find((row) => row.id === last.id)?.reactions,
    ).toHaveLength(1);
    // Every row of the page is covered: no further aux read.
    expect(pending.filter((entry) => entry.filters[0]?.top_level)).toEqual([]);
  });
  it("evicting a window aborts its pages' aux read and drops the rest", async () => {
    const { queries, pending } = setup(1);
    queries.ensure("c");
    const newer = message(alice, "c", "newer", 20),
      older = message(alice, "c", "older", 10),
      oldest = message(alice, "c", "oldest", 5);
    const window = () => pending.filter((read) => read.filters[0]?.top_level);
    const take = () => {
      const [read] = window();
      assert(read);
      pending.splice(pending.indexOf(read), 1);
      return read;
    };
    take().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    for (const [row, cursor] of [
      [older, newer],
      [oldest, older],
    ] as const) {
      queries.loadOlder("c");
      const page = window().find((read) => !read.filters[0]?.include_aux);
      assert(page);
      pending.splice(pending.indexOf(page), 1);
      page.respond([
        row,
        bounds(relay, "c", `${cursor.created_at}:${cursor.id}`, {
          has_more: true,
          next_cursor: { created_at: row.created_at, id: row.id },
        }),
      ]);
      await flush();
    }
    // One aux read at a time: the first page's, with the second queued.
    const aux = window();
    expect(aux.map((read) => read.filters[0]?.until)).toEqual([20]);
    queries.ensure("d");
    expect(aux[0]?.signal?.aborted).toBe(true);
    expect(
      window().filter(
        (read) => read.filters[0]?.["#h"]?.[0] === "c" && !read.signal?.aborted,
      ),
    ).toEqual([]);
  });
  it("keeps rows older than a paged window's history bound out until a page reaches them", async () => {
    // Agents, search and previews read single old messages through the
    // session. Merging one into an open window above its loaded history makes
    // a gap that later pages fill in the middle, which the timeline reads as
    // new arrivals and does not anchor, so the reader jumps back.
    const { store, queries, next, pending } = setup();
    const page = (filter: Record<string, unknown>) => {
      const index = pending.findIndex((entry) =>
        Object.entries(filter).every(
          ([key, value]) =>
            JSON.stringify(entry.filters[0]?.[key as "limit"]) ===
            JSON.stringify(value),
        ),
      );
      const [entry] = pending.splice(index, 1);
      assert.exists(entry);
      return entry;
    };
    const newer = message(alice, "c", "newer", 20),
      middle = message(alice, "c", "middle", 10),
      old = message(alice, "c", "old", 5);
    // Read before the window opens: it also seeds the live tail.
    const early = store.session.read([{ ids: [old.id], limit: 1 }]);
    next().respond([old]);
    await early;
    queries.ensure("c");
    next().respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([newer.id]);
    // Read while the window is open.
    const late = store.session.read([{ ids: [old.id], limit: 1 }]);
    page({ ids: [old.id] }).respond([old]);
    await late;
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([newer.id]);
    // A read inside the loaded history still lands.
    const live = message(alice, "c", "live", 30);
    const current = store.session.read([{ ids: [live.id], limit: 1 }]);
    page({ ids: [live.id] }).respond([live]);
    await current;
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([
      newer.id,
      live.id,
    ]);
    queries.loadOlder("c");
    page({ until: 20 }).respond([
      middle,
      old,
      bounds(relay, "c", `20:${newer.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(queries.window("c").rows.map((row) => row.id)).toEqual([
      old.id,
      middle.id,
      newer.id,
      live.id,
    ]);
    store.dispose();
  });
  it("evicts the least recently ensured window beyond capacity, aborting its request and rejecting late results", async () => {
    const { queries, store, next, pending } = setup(2);
    const evicted = vi.fn();
    queries.subscribeWindow("a", evicted);
    queries.ensure("a");
    const requestA = next();
    queries.ensure("b");
    next().respond([
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    queries.ensure("c");
    expect(store.retainedChannels()).toEqual(["b", "c"]);
    expect(requestA.signal?.aborted).toBe(true);
    expect(queries.window("a")).toMatchObject({ status: "idle", rows: [] });
    requestA.respond([
      message(alice, "a", "late", 1),
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(queries.window("a")).toMatchObject({ status: "idle", rows: [] });
    // Re-ensuring a still-retained window only touches recency; re-ensuring the evicted one reloads it.
    queries.ensure("b");
    expect(store.retainedChannels()).toEqual(["c", "b"]);
    queries.ensure("a");
    expect(store.retainedChannels()).toEqual(["b", "a"]);
    const lateRead = pending.at(-1);
    assert.exists(lateRead);
    expect(lateRead.filters[0]).toMatchObject({ "#h": ["a"] });
    store.dispose();
    lateRead.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(queries.window("a").status).not.toBe("ready");
  });
  it("surfaces bounds failures as window errors and lets ensure retry", async () => {
    const { queries, next } = setup();
    queries.ensure("c");
    next().respond([message(alice, "c", "no bounds", 1)]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "error",
      error: expect.stringMatching(/window bounds/),
    });
    queries.ensure("c");
    expect(queries.window("c").status).toBe("loading");
    next().respond([
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 1, id: id(1) },
      }),
    ]);
    await flush();
    queries.loadOlder("c");
    next().fail(new Error("relay down"));
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      loadingOlder: false,
      error: "relay down",
      hasMore: true,
    });
  });
});

it("projects explicit visibility and replaces description-only changes", async () => {
  const { store, queries, next } = setup();
  try {
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    expect(queries.list().channels[0]?.visibility).toBeUndefined();
    for (const [index, description] of [
      "First description",
      "Second description",
      "",
    ].entries()) {
      const old = queries.list().channels[0];
      queries.refreshList?.();
      next().respond([
        roster(relay, "work", [viewer.pubkey]),
        metadata(relay, "work", "Work", 1_700_000_001 + index, [
          ["public"],
          ["about", description],
          ["t", "stream"],
        ]),
      ]);
      await flush();
      expect(queries.list().channels[0]).not.toBe(old);
      expect(queries.list().channels[0]).toMatchObject({
        description,
        visibility: "public",
      });
    }
  } finally {
    store.dispose();
  }
});

it("projects the signed metadata lifetime and replaces lifetime-only changes", async () => {
  const { store, queries, next } = setup();
  try {
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    expect(queries.list().channels[0]).not.toHaveProperty("ttlSeconds");
    // Malformed metadata keeps the channel listed without inventing a lifetime.
    for (const [index, [ttl, expected, replaced]] of (
      [
        [["ttl", "604800"], 604800, true],
        [["ttl", "86400"], 86400, true],
        [["ttl", "01"], undefined, true],
        [[], undefined, false],
      ] as const
    ).entries()) {
      const old = queries.list().channels[0];
      queries.refreshList?.();
      next().respond([
        roster(relay, "work", [viewer.pubkey]),
        metadata(relay, "work", "Work", 1_700_000_001 + index, [
          ...(ttl.length ? [[...ttl]] : []),
          ["t", "stream"],
        ]),
      ]);
      await flush();
      const channel = queries.list().channels[0];
      expect(channel?.name).toBe("Work");
      expect(channel?.ttlSeconds).toBe(expected);
      expect(channel === old).toBe(!replaced);
    }
  } finally {
    store.dispose();
  }
});

/** Two joined channels discovered in one short page, so the list is ready. */
async function discovered(test: ReturnType<typeof setup>) {
  test.queries.ensureList();
  test
    .next()
    .respond([
      roster(relay, "a", [viewer.pubkey]),
      metadata(relay, "a", "Alpha"),
      roster(relay, "b", [viewer.pubkey]),
      metadata(relay, "b", "Beta"),
    ]);
  await vi.waitFor(() =>
    expect(test.queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "a" }, { id: "b" }],
    }),
  );
  await vi.waitFor(() =>
    expect(test.store.session.live.snapshot().roster.state).toBe("verified"),
  );
}
it("refreshes one channel's roster with an exact read and merges it without dropping other channels", async () => {
  const test = setup();
  const { queries, next, pending } = test;
  const agent = keypair().pubkey;
  try {
    await discovered(test);
    const listener = vi.fn();
    const unsubscribe = queries.subscribeList(listener);
    const refreshing = queries.refreshRoster?.("a");
    expect(pending).toHaveLength(1);
    const request = next();
    expect(request.filters).toEqual([
      {
        kinds: [39002],
        authors: [relay.pubkey],
        "#d": ["a"],
        "#p": [viewer.pubkey],
        limit: 2,
      },
    ]);
    request.respond([
      roster(relay, "a", [viewer.pubkey, agent], 1_700_000_001),
    ]);
    await expect(refreshing).resolves.toBe(true);
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [
        { id: "a", name: "Alpha", members: [agent, viewer.pubkey].sort() },
        { id: "b", name: "Beta", members: [viewer.pubkey] },
      ],
    });
    expect(listener).toHaveBeenCalledOnce();
    await flush();
    // One exact read; no viewer-wide roster page followed it.
    expect(pending).toHaveLength(0);
    unsubscribe();
  } finally {
    test.store.dispose();
  }
});
it("stamps rosterAsOf only when a complete roster read commits", async () => {
  let clock = 1_000;
  const test = setup(2, () => ++clock);
  try {
    await discovered(test);
    const complete = test.queries.list().rosterAsOf;
    expect(complete).toBeDefined();
    // An exact roster read commits the list again, but proves no absence.
    const refreshing = test.queries.refreshRoster?.("a");
    test
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey, alice.pubkey], 1_700_000_001),
      ]);
    await expect(refreshing).resolves.toBe(true);
    const exact = test.queries.list();
    expect(exact.asOf).toBeGreaterThan(complete ?? Infinity);
    expect(exact.rosterAsOf).toBe(complete);
  } finally {
    test.store.dispose();
  }
});
it("keeps rosterAsOf through a failed refresh and its retry", async () => {
  const test = setup();
  const { queries, next, pending } = test;
  try {
    await discovered(test);
    const complete = queries.list().rosterAsOf;
    expect(complete).toBeDefined();
    queries.refreshList?.();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    next().fail(new Error("offline"));
    await vi.waitFor(() => expect(queries.list().status).toBe("error"));
    expect(queries.list()).toMatchObject({
      coverage: "partial",
      rosterAsOf: complete,
    });
    // The retry republishes the kept channels as loading, then page by page.
    const seen: unknown[] = [];
    const stop = queries.subscribeList(() => seen.push(queries.list()));
    queries.refreshList?.();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(queries.list()).toMatchObject({
      status: "loading",
      rosterAsOf: complete,
    });
    next().respond([
      roster(relay, "a", [viewer.pubkey]),
      metadata(relay, "a", "Alpha"),
      roster(relay, "b", [viewer.pubkey]),
      metadata(relay, "b", "Beta"),
    ]);
    await vi.waitFor(() =>
      expect(test.store.session.live.snapshot().roster.state).toBe("verified"),
    );
    stop();
    expect(seen.length).toBeGreaterThan(0);
    for (const list of seen) expect(list).toHaveProperty("rosterAsOf");
    expect(queries.list().status).toBe("ready");
    expect(queries.list().coverage).toBeUndefined();
  } finally {
    test.store.dispose();
  }
});
it("reports no fresh roster evidence when an exact read omits the cached channel", async () => {
  const test = setup();
  try {
    await discovered(test);
    const before = test.queries.list();
    const refreshing = test.queries.refreshRoster?.("a");
    test.next().respond([]);
    await expect(refreshing).resolves.toBe(false);
    expect(test.queries.list()).toBe(before);
  } finally {
    test.store.dispose();
  }
});
it.each([
  ["older", 1_700_000_000, false],
  ["identical", 1_700_000_001, true],
] as const)(
  "requires discovery confirmation for an %s roster over a restored cache",
  async (_version, timestamp, confirmed) => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    const cached = roster(
      relay,
      "alpha",
      [viewer.pubkey, alice.pubkey],
      1_700_000_001,
    );
    const persistence: HeadPersistence = {
      read: async () => [],
      readStartup: async () => ({
        discovery: {
          savedAt: Date.now(),
          relayAuthor: relay.pubkey,
          events: [cached, metadata(relay, "alpha", "Alpha")],
        },
      }),
      writeStartup: async () => {},
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close: () => {},
    };
    const owner = createRelaySession(scripted.transport, {
      persistence,
      prepared: true,
    });
    try {
      await owner.restore();
      expect(owner.session.channels.list().channels[0]?.cached).toBe(true);
      const refreshing = owner.session.channels.refreshRoster?.("alpha");
      scripted
        .next()
        .respond([
          roster(relay, "alpha", [viewer.pubkey, alice.pubkey], timestamp),
        ]);
      await expect(refreshing).resolves.toBe(confirmed);
      expect(!!owner.session.channels.list().channels[0]?.cached).toBe(
        !confirmed,
      );
    } finally {
      owner.dispose();
    }
  },
);
it("keeps a cached denial and never reads for a channel it does not authorize", async () => {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const agent = keypair().pubkey;
  // A restored launch snapshot: alpha's membership is display-only until a
  // fresh relay roster confirms it.
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [
          roster(relay, "alpha", [viewer.pubkey]),
          metadata(relay, "alpha", "Alpha"),
        ],
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(scripted.transport, {
    persistence,
    prepared: true,
  });
  const queries = owner.session.channels;
  try {
    await owner.restore();
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "alpha", cached: true }],
    });
    // The exact viewer-scoped read omits the restored roster: a cached denial.
    const resolving = queries.resolve?.(["alpha"]);
    expect(scripted.pending).toHaveLength(1);
    scripted.next().respond([]);
    await expect(resolving).resolves.toBeUndefined();
    expect(queries.get?.("alpha")).toBeUndefined();
    expect(queries.list().channels).toEqual([]);
    queries.ensureList();
    await vi.waitFor(() => expect(scripted.pending).toHaveLength(1));
    scripted
      .next()
      .respond([
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "beta", "Beta"),
      ]);
    await vi.waitFor(() =>
      expect(queries.list()).toMatchObject({
        status: "ready",
        channels: [{ id: "beta" }],
      }),
    );
    // A denied id is not this method's to re-read: no request leaves, and the
    // denial stands. Fresh admission belongs to `resolve` and the full pass.
    await expect(queries.refreshRoster?.("alpha")).resolves.toBe(false);
    expect(scripted.pending).toHaveLength(0);
    const refreshing = queries.refreshRoster?.("beta");
    expect(scripted.pending).toHaveLength(1);
    scripted
      .next()
      .respond([roster(relay, "beta", [viewer.pubkey, agent], 1_700_000_001)]);
    await expect(refreshing).resolves.toBe(true);
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "beta", members: [agent, viewer.pubkey].sort() }],
    });
    expect(queries.get?.("alpha")).toBeUndefined();
  } finally {
    owner.dispose();
  }
});
it("writes one startup snapshot with the final content after a burst of discovery batches", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const writeStartup = vi.fn(async (_patch: SavedStartup) => {});
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      persistence: {
        read: async () => [],
        readStartup: async () => undefined,
        writeStartup,
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close: () => {},
      },
      prepared: true,
    },
  );
  try {
    const ids = ["a", "b", "c", "d"];
    for (const channel of ids)
      live.receive([roster(relay, channel, [viewer.pubkey])]);
    live.receive([metadata(relay, "a", "Alpha")]);
    vi.advanceTimersByTime(499);
    expect(writeStartup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(writeStartup).toHaveBeenCalledTimes(1);
    const [patch] = writeStartup.mock.calls[0] ?? [];
    assert(patch);
    const saved = (patch.discovery?.events ?? []) as RelayEvent[];
    expect(
      saved.map((event) => [event.kind, event.tags[0]?.[1]]).sort(),
    ).toEqual([
      [39000, "a"],
      [39002, "a"],
      [39002, "b"],
      [39002, "c"],
      [39002, "d"],
    ]);
    vi.advanceTimersByTime(5_000);
    expect(writeStartup).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it("rewrites the startup snapshot only when its roster changes or ages", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const writeStartup = vi.fn(async (_patch: SavedStartup) => {});
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      persistence: {
        read: async () => [],
        readStartup: async () => undefined,
        writeStartup,
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close: () => {},
      },
      prepared: true,
    },
  );
  const discoveryWrites = () =>
    writeStartup.mock.calls.filter(([patch]) => patch.discovery).length;
  try {
    const first = roster(relay, "a", [viewer.pubkey]);
    live.receive([first]);
    vi.advanceTimersByTime(500);
    expect(discoveryWrites()).toBe(1);
    // Catch-up delivers the same version again.
    live.receive([first]);
    vi.advanceTimersByTime(500);
    expect(discoveryWrites()).toBe(1);
    live.receive([roster(relay, "b", [viewer.pubkey])]);
    vi.advanceTimersByTime(500);
    expect(discoveryWrites()).toBe(2);
    // An unchanged roster is written again after ten minutes, and after the
    // clock moves back, so restore never meets a stale or future copy.
    vi.advanceTimersByTime(599_000);
    live.receive([first]);
    vi.advanceTimersByTime(500);
    expect(discoveryWrites()).toBe(2);
    vi.advanceTimersByTime(500);
    live.receive([first]);
    vi.advanceTimersByTime(500);
    expect(discoveryWrites()).toBe(3);
    vi.setSystemTime(Date.now() - 60_000);
    live.receive([first]);
    vi.advanceTimersByTime(500);
    expect(discoveryWrites()).toBe(4);
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it.each([
  ["saves once after", false],
  ["drops the pending save when the cache is purged during", true],
] as const)("%s a burst of profile changes", async (_, purge) => {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const writeProfiles = vi.fn(async (_: readonly unknown[]) => {});
  // Fake from the start: a save armed on the real clock would hold the burst.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const owner = createRelaySession(scripted.transport, {
    persistence: {
      read: async () => [],
      readStartup: async () => undefined,
      writeStartup: async () => {},
      readProfiles: async () => [],
      writeProfiles,
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close: () => {},
    },
    prepared: true,
  });
  const queries = owner.session.channels;
  try {
    await owner.restore();
    queries.ensureList();
    await vi.waitFor(() => expect(scripted.pending).toHaveLength(1));
    scripted
      .next()
      .respond([
        roster(relay, "alpha", [viewer.pubkey, alice.pubkey]),
        metadata(relay, "alpha", "Alpha"),
        roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
        metadata(relay, "dm", "Direct", undefined, [["t", "dm"]]),
      ]);
    await vi.waitFor(() => expect(queries.list().status).toBe("ready"));
    await vi.advanceTimersByTimeAsync(1000);
    writeProfiles.mockClear();
    for (const person of [alice, keypair()]) {
      const ensuring = owner.session.profiles.ensure(
        [person.pubkey],
        "foreground",
      );
      // Fake-clock polls advance 1ms each, far inside the save delay.
      await vi.waitFor(() => expect(scripted.pending).not.toHaveLength(0), {
        interval: 1,
      });
      scripted.next().respond([profile(person, { name: "Person" })]);
      await ensuring;
      expect(owner.session.profiles.snapshot().get(person.pubkey)?.name).toBe(
        "Person",
      );
    }
    expect(writeProfiles).not.toHaveBeenCalled();
    if (purge) {
      const clearing = owner.clearCache();
      await vi.advanceTimersByTimeAsync(1000);
      await clearing;
      expect(writeProfiles).not.toHaveBeenCalled();
    } else {
      await vi.advanceTimersByTimeAsync(1000);
      expect(writeProfiles).toHaveBeenCalledTimes(1);
      expect(writeProfiles.mock.calls[0]?.[0]).toHaveLength(2);
    }
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it.each([
  ["restores", false],
  ["skips", true],
] as const)(
  "%s the saved roster when revalidate is %s",
  async (_, revalidate) => {
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession(scripted.transport, {
      persistence: {
        read: async () => [],
        readStartup: async () => ({
          discovery: {
            savedAt: Date.now(),
            relayAuthor: relay.pubkey,
            events: [
              roster(relay, "alpha", [viewer.pubkey]),
              metadata(relay, "alpha", "Alpha"),
            ],
          },
        }),
        writeStartup: async () => {},
        readProfiles: async () => [],
        writeProfiles: async () => {},
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close: () => {},
      },
      prepared: true,
      revalidate,
    });
    try {
      await owner.restore();
      expect(!!owner.session.channels.get?.("alpha")).toBe(!revalidate);
    } finally {
      owner.dispose();
    }
  },
);
it("a revalidating session keeps saving profiles", async () => {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const readStartup = vi.fn(async () => undefined);
  const writeProfiles = vi.fn(async (_: readonly unknown[]) => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const owner = createRelaySession(scripted.transport, {
    persistence: {
      read: async () => [],
      readStartup,
      writeStartup: async () => {},
      readProfiles: async () => [],
      writeProfiles,
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close: () => {},
    },
    prepared: true,
    revalidate: true,
  });
  try {
    await owner.restore();
    await vi.advanceTimersByTimeAsync(1000);
    writeProfiles.mockClear();
    const ensuring = owner.session.profiles.ensure(
      [alice.pubkey],
      "foreground",
    );
    await vi.waitFor(() => expect(scripted.pending).not.toHaveLength(0), {
      interval: 1,
    });
    scripted.next().respond([profile(alice, { name: "Alice" })]);
    await ensuring;
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeProfiles).toHaveBeenCalledTimes(1);
    expect(writeProfiles.mock.calls[0]?.[0]).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it("does not rewrite the profile mirror when only cache hits reorder it", async () => {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const writeProfiles = vi.fn(async (_: readonly unknown[]) => {});
  const bob = keypair();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const owner = createRelaySession(scripted.transport, {
    persistence: {
      read: async () => [],
      readStartup: async () => undefined,
      writeStartup: async () => {},
      readProfiles: async () => [],
      writeProfiles,
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close: () => {},
    },
    prepared: true,
  });
  const profiles = owner.session.profiles;
  const load = async (ids: string[], events: RelayEvent[]) => {
    const ensuring = profiles.ensure(ids, "foreground");
    await vi.waitFor(() => expect(scripted.pending).not.toHaveLength(0), {
      interval: 1,
    });
    scripted.next().respond(events);
    await ensuring;
    await vi.advanceTimersByTimeAsync(1000);
  };
  try {
    await owner.restore();
    await load([alice.pubkey], [profile(alice, { name: "Alice" })]);
    await load([bob.pubkey], [profile(bob, { name: "Bob" })]);
    expect(writeProfiles).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.anything(), expect.anything()]),
      [],
    );
    writeProfiles.mockClear();
    // A hit reorders the cache; an unanswered name notifies without a new profile.
    await load([alice.pubkey, keypair().pubkey], []);
    expect(writeProfiles).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});
it.each(["idle", "loading", "error"] as const)(
  "rejects a roster refresh without reading while the list is %s",
  async (status) => {
    const test = setup();
    const { queries, next, pending } = test;
    try {
      if (status !== "idle") queries.ensureList();
      if (status === "error") {
        next().fail(new Error("offline"));
        await vi.waitFor(() => expect(queries.list().status).toBe("error"));
      }
      expect(queries.list().status).toBe(status);
      const outstanding = pending.length;
      await expect(queries.refreshRoster?.("a")).rejects.toThrow(/not ready/);
      expect(pending).toHaveLength(outstanding);
      expect(queries.list().status).toBe(status);
    } finally {
      test.store.dispose();
    }
  },
);
it.each<[string, (agent: string) => ReturnType<typeof roster>[]]>([
  [
    "a roster signed by another key",
    (agent) => [roster(keypair(), "a", [viewer.pubkey, agent], 1_700_000_001)],
  ],
  [
    "another channel's roster",
    (agent) => [roster(relay, "b", [viewer.pubkey, agent], 1_700_000_001)],
  ],
  [
    "two rosters",
    (agent) => [
      roster(relay, "a", [viewer.pubkey, agent], 1_700_000_001),
      roster(relay, "a", [viewer.pubkey, agent], 1_700_000_002),
    ],
  ],
])(
  "rejects %s from an exact roster read and leaves the list unchanged",
  async (_response, answer) => {
    const test = setup();
    const { queries, next, pending } = test;
    const agent = keypair().pubkey;
    try {
      await discovered(test);
      const before = queries.list();
      const refreshing = queries.refreshRoster?.("a");
      next().respond(answer(agent));
      await expect(refreshing).rejects.toThrow(/read budget/);
      expect(queries.list()).toBe(before);
      await flush();
      expect(pending).toHaveLength(0);
    } finally {
      test.store.dispose();
    }
  },
);
it("does not commit a roster read that lands after the list stopped being ready", async () => {
  const test = setup();
  const { queries, pending } = test;
  const agent = keypair().pubkey;
  try {
    await discovered(test);
    queries.refreshList?.();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const refreshing = queries.refreshRoster?.("a");
    expect(pending).toHaveLength(2);
    const page = pending.find((request) =>
      request.filters.some((filter) => filter["#p"] && !filter["#d"]),
    );
    const exact = pending.find((request) =>
      request.filters.some((filter) => filter["#d"]),
    );
    pending.splice(0);
    page?.fail(new Error("offline"));
    await vi.waitFor(() => expect(queries.list().status).toBe("error"));
    exact?.respond([roster(relay, "a", [viewer.pubkey, agent], 1_700_000_001)]);
    // Committing now would publish a ready list over the failed rediscovery.
    await expect(refreshing).rejects.toThrow(/Stale roster refresh/);
    expect(queries.list()).toMatchObject({
      status: "error",
      channels: [
        { id: "a", members: [viewer.pubkey] },
        { id: "b", members: [viewer.pubkey] },
      ],
    });
  } finally {
    test.store.dispose();
  }
});

it.each([
  [48100, 48103],
  [48103, 48100],
])(
  "keeps one Huddle card when live events arrive as %s then %s",
  async (first, second) => {
    let receive!: (events: readonly import("./events").RelayEvent[]) => void;
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        if (filters.some((filter) => filter.top_level))
          return [
            bounds(relay, "parent", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return [
          roster(relay, "parent", [viewer.pubkey]),
          metadata(relay, "parent", "Parent"),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        );
      },
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      const channels = owner.session.channels;
      channels.ensureList();
      await vi.waitFor(() => expect(channels.list().status).toBe("ready"));
      channels.ensure("parent");
      await vi.waitFor(() =>
        expect(channels.window("parent").status).toBe("ready"),
      );
      let startId: string | undefined;
      for (const kind of [first, second]) {
        const event = signed(relay, {
          kind,
          tags: [["h", "parent"]],
          content: JSON.stringify({
            ephemeral_channel_id: "00000000-0000-4000-8000-000000000002",
          }),
        });
        if (kind === 48100) startId = event.id;
        receive([event]);
        expect(channels.window("parent").rows).toEqual([
          expect.objectContaining({
            id: startId ?? event.id,
            huddle: expect.objectContaining({
              state: startId ? "started" : "ended",
            }),
          }),
        ]);
      }
    } finally {
      owner.dispose();
    }
  },
);

describe("creator proof reads", () => {
  const stream = (
    channel: string,
    creator = alice.pubkey,
    createdAt = 1_700_000_000,
  ) =>
    metadata(relay, channel, channel, createdAt, [
      ["t", "stream"],
      ["P", creator],
    ]);
  type Pending = ReturnType<typeof setup>["pending"];
  /** Answer metadata reads with stream metadata and every other read with
   * nothing, until only creator proofs are pending; return those. */
  async function proofs(
    pending: Pending,
    creators = new Map<string, string>(),
  ) {
    for (let round = 0; round < 20; round++) {
      await flush();
      const found = pending.filter((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(9007)),
      );
      const other = pending.filter((entry) => !found.includes(entry));
      if (found.length && !other.length) return found;
      for (const entry of other) {
        pending.splice(pending.indexOf(entry), 1);
        entry.respond(
          entry.filters.flatMap((filter) =>
            filter.kinds?.includes(39000)
              ? (filter["#d"] ?? []).map((channel) =>
                  stream(channel, creators.get(channel)),
                )
              : [],
          ),
        );
      }
    }
    throw new Error("no creator proof read");
  }
  async function listed(channels: readonly string[]) {
    const test = setup();
    test.queries.ensureList();
    test
      .next()
      .respond(
        channels.map((channel) => roster(relay, channel, [viewer.pubkey])),
      );
    return test;
  }

  it("reads up to 250 channels' creations in one filter", async () => {
    const channels = Array.from({ length: 300 }, (_, i) => `c${i}`);
    const creators = new Map(
      channels.map((channel, i) => [
        channel,
        i % 2 ? alice.pubkey : viewer.pubkey,
      ]),
    );
    const { store, pending } = await listed(channels);
    try {
      const [read] = await proofs(pending, creators);
      assert.exists(read);
      const [first, second] = read.filters;
      expect(read.filters).toHaveLength(2);
      expect([first?.limit, second?.limit]).toEqual([500, 100]);
      expect([first?.["#h"]?.length, second?.["#h"]?.length]).toEqual([
        250, 50,
      ]);
      expect(
        new Set([...(first?.["#h"] ?? []), ...(second?.["#h"] ?? [])]),
      ).toEqual(new Set(channels));
      for (const filter of read.filters) {
        expect(filter.kinds).toEqual([9007]);
        expect(new Set(filter.authors)).toEqual(
          new Set([viewer.pubkey, alice.pubkey]),
        );
      }
    } finally {
      store.dispose();
    }
  });

  /** A session fed live, with the creator-proof reads it has pending. */
  function liveSession() {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    const reads = () =>
      wire.pending.filter((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(9007)),
      );
    return {
      owner,
      reads,
      receive: async (events: RelayEvent[]) => {
        live.receive(events);
        await flush();
      },
      take() {
        const [read] = reads();
        assert.exists(read);
        wire.pending.splice(wire.pending.indexOf(read), 1);
        return read;
      },
    };
  }
  const creation = (channel: string, extra: string[][] = []) =>
    signed(alice, {
      kind: 9007,
      created_at: 1_700_000_000,
      content: "",
      tags: [["h", channel], ...extra],
    });

  /** Holds the monotonic clock at `at` ms, with no retry jitter. */
  function clock() {
    let at = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => at);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    return {
      advance(ms: number) {
        at += ms;
      },
      restore() {
        now.mockRestore();
        random.mockRestore();
      },
    };
  }

  it("reads a channel's creation once as membership changes republish its metadata", async () => {
    // Each membership change republishes 39000 to every online member. A read
    // per version, times members, times a run of adds, was a relay-wide burst.
    const time = clock();
    const { owner, reads, receive, take } = liveSession();
    const members = [viewer.pubkey];
    const add = () => {
      members.push(keypair().pubkey);
      const at = 1_700_000_000 + members.length;
      return receive([
        roster(relay, "a", members, at),
        stream("a", alice.pubkey, at),
      ]);
    };
    try {
      await receive([roster(relay, "a", members), stream("a")]);
      take().fail(new Error("offline"));
      await flush();
      // A failed read backs off rather than retrying on every version.
      await add();
      expect(reads()).toEqual([]);
      time.advance(60_000);
      await add();
      const first = take();
      expect(first.filters).toMatchObject([
        { kinds: [9007], authors: [alice.pubkey], "#h": ["a"] },
      ]);
      // A version arriving while that read is in flight shares it.
      await add();
      expect(reads()).toEqual([]);
      first.respond([creation("a")]);
      await flush();
      for (let n = 0; n < 3; n++) await add();
      time.advance(24 * 3_600_000);
      await add();
      // Every version was applied, so each one was a candidate for a read.
      expect(owner.session.channels.list().channels[0]?.members).toHaveLength(
        members.length,
      );
      expect(reads()).toEqual([]);
    } finally {
      owner.dispose();
      time.restore();
    }
  });

  it("lets the next version read again after a cancelled creation read", async () => {
    // A cancelled read learned nothing, so it must not back off: a cancelled
    // lookup would otherwise hold off the channel's proof for a minute or more.
    const time = clock();
    const { owner, reads, receive, take } = liveSession();
    try {
      await receive([roster(relay, "a", [viewer.pubkey]), stream("a")]);
      take().fail(new DOMException("Cancelled", "AbortError"));
      await flush();
      const at = 1_700_000_001;
      await receive([
        roster(relay, "a", [viewer.pubkey, keypair().pubkey], at),
        stream("a", alice.pubkey, at),
      ]);
      expect(reads()).toHaveLength(1);
    } finally {
      owner.dispose();
      time.restore();
    }
  });

  it("retries a missing creation with backoff until it arrives", async () => {
    // A live 39000 can precede its creation on a read replica, and a channel
    // first seen long after creation can still meet a lagging replica. No
    // miss is final, or a Huddle could stay classified as an ordinary channel.
    const parent = "00000000-0000-4000-8000-000000000001";
    const room = "00000000-0000-4000-8000-000000000002";
    const about = huddleDescription(parent);
    let at = 1_700_000_000;
    const version = () => {
      at += 1;
      return [
        roster(relay, room, [viewer.pubkey], at),
        metadata(relay, room, "Huddle", at, [
          ["P", alice.pubkey],
          ["private"],
          ["t", "stream"],
          ["created_at", String(1_600_000_000)],
          ["ttl", "3600"],
          ["about", about],
        ]),
      ];
    };
    const summary = () =>
      owner.session.channels.list().channels.find(({ id }) => id === room);
    const time = clock();
    const { owner, reads, receive, take } = liveSession();
    try {
      await receive(version());
      take().respond([]);
      await flush();
      expect(summary()?.parentChannelId).toBeUndefined();
      time.advance(59_999);
      await receive(version());
      expect(reads()).toEqual([]);
      time.advance(1);
      await receive(version());
      take().respond([]);
      await flush();
      // The second miss doubles the backoff.
      time.advance(119_999);
      await receive(version());
      expect(reads()).toEqual([]);
      time.advance(1);
      await receive(version());
      take().respond([
        creation(room, [
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["about", about],
        ]),
      ]);
      await flush();
      expect(summary()).toMatchObject({
        huddle: true,
        parentChannelId: parent,
      });
      time.advance(24 * 3_600_000);
      await receive(version());
      expect(reads()).toEqual([]);
    } finally {
      owner.dispose();
      time.restore();
    }
  });

  it.each(["missing", "cross-author", "ambiguous-coordinate"])(
    "retries a %s proof after a filter reaches its limit",
    async (receipt) => {
      const { store, queries, pending } = await listed(["a", "b"]);
      const creators = new Map([["a", viewer.pubkey]]);
      try {
        const [first] = await proofs(pending, creators);
        assert.exists(first);
        expect(first.filters).toMatchObject([{ "#h": ["a", "b"], limit: 4 }]);
        pending.splice(pending.indexOf(first), 1);
        // The shared author set admits viewer's creation in b, whose creator is
        // alice. Neither that cross match nor an ambiguous coordinate proves b.
        first.respond(
          [0, 1, 2, 3].map((n) =>
            signed(
              receipt === "ambiguous-coordinate" && n > 0 ? alice : viewer,
              {
                kind: 9007,
                created_at: 1_700_000_000 - n,
                content: "",
                tags:
                  n === 0 || receipt === "missing"
                    ? [["h", "a"]]
                    : receipt === "cross-author"
                      ? [["h", "b"]]
                      : [
                          ["h", "outside"],
                          ["h", "b"],
                        ],
              },
            ),
          ),
        );
        await flush();
        queries.refreshList?.();
        pending
          .shift()
          ?.respond([
            roster(relay, "a", [viewer.pubkey]),
            stream("a", viewer.pubkey),
            roster(relay, "b", [viewer.pubkey]),
            stream("b"),
          ]);
        const [again] = await proofs(pending);
        assert.exists(again);
        expect(again.filters).toMatchObject([{ "#h": ["b"], limit: 2 }]);
      } finally {
        store.dispose();
      }
    },
  );
});

it("settles a metadata retry during quota cooldown without issuing another read", async () => {
  const { store, queries, next, pending } = setup();
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    queries.ensureList();
    next().respond([roster(relay, "a", [viewer.pubkey])]);
    await flush();
    next().fail(new ReadError("unavailable", "Quota", 429, 5000));
    await flush();
    const failed = queries.list();
    expect(failed.status).toBe("error");
    expect(failed.channels[0]?.metadataPending).toBe(true);
    const settled = vi.fn();
    const stop = queries.subscribeList(settled);
    queries.ensureList();
    await flush();
    expect(pending).toHaveLength(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(queries.list()).not.toBe(failed);
    expect(queries.list()).toEqual(failed);
    stop();
    clock.mockReturnValue(6001);
    queries.ensureList();
    next().respond([roster(relay, "a", [viewer.pubkey])]);
    await flush();
    next().respond([metadata(relay, "a", "Alpha")]);
    await flush();
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ name: "Alpha", metadataPending: undefined }],
    });
  } finally {
    store.dispose();
    clock.mockRestore();
  }
});

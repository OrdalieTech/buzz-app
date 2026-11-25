// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../relay/events";
import type { LiveListener } from "../relay/incoming";
import type { PinSource } from "../relay/pins";
import { usePinnedMessages, usePinnedRows } from "./use-pins";

afterEach(cleanup);

const relay = "a".repeat(64),
  author = "c".repeat(64);
const one = "1".repeat(64),
  two = "2".repeat(64);
const message = (id: string, content = id.slice(0, 1)): EventData => ({
  id,
  pubkey: author,
  created_at: 100,
  kind: 9,
  tags: [["h", "c"]],
  content,
});

function source(
  read: (filters: readonly ReadFilter[]) => Promise<readonly EventData[]>,
) {
  const listeners = new Set<LiveListener>();
  const live = new Set<() => void>();
  let heads: { channelId: string; state: string }[] = [];
  const owners = new Map<string, string>();
  const profiles = new Set<() => void>();
  const value: PinSource = {
    relayAuthor: relay,
    workflowAuthority: relay,
    profiles: {
      owner: (pubkey) => owners.get(pubkey),
      subscribe(listener) {
        profiles.add(listener);
        return () => profiles.delete(listener);
      },
    },
    read: vi.fn(read),
    async readPage(filters, settings) {
      const events = await value.read(filters, settings);
      return { events, relayCount: events.length };
    },
    subscribeLive(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    live: {
      snapshot: () => ({ heads }),
      subscribe(listener) {
        live.add(listener);
        return () => live.delete(listener);
      },
    },
  };
  const deliver = (events: EventData[]) => {
    for (const listener of listeners)
      listener({ events } as unknown as Parameters<LiveListener>[0]);
  };
  const catchUp = (channelId: string) => {
    for (const state of ["pending", "established"]) {
      heads = [{ channelId, state }];
      for (const listener of live) listener();
    }
  };
  const learnOwner = (agent: string, owner: string) => {
    owners.set(agent, owner);
    for (const listener of profiles) listener();
  };
  return { value, deliver, catchUp, learnOwner };
}

it("reads a failed list once however often its readers render", async () => {
  const s = source(async () => {
    throw new Error("offline");
  });
  const { result, rerender } = renderHook(() =>
    usePinnedMessages(s.value, "c"),
  );
  await waitFor(() => expect(result.current.status).toBe("error"));
  for (let index = 0; index < 5; index++) rerender();
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(s.value.read).toHaveBeenCalledTimes(1);
});

const idsRead = (s: ReturnType<typeof source>) =>
  vi
    .mocked(s.value.read)
    .mock.calls.flatMap(([[filter]]) => (filter?.ids ? [filter.ids] : []));

it("reads only pins it has not loaded when the list changes", async () => {
  let fail = false;
  const s = source(async ([filter]) => {
    if (fail) throw new Error("offline");
    return filter?.ids ? filter.ids.map((id) => message(id)) : [];
  });
  const { result, rerender } = renderHook(
    ({ ids }) => usePinnedRows(s.value, "c", ids),
    { initialProps: { ids: [one] } },
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  rerender({ ids: [two, one] });
  await waitFor(() =>
    expect(result.current.rows.map((row) => row.id)).toEqual([two, one]),
  );
  // An unpin reads nothing.
  rerender({ ids: [one] });
  expect(result.current.rows.map((row) => row.id)).toEqual([one]);
  expect(idsRead(s)).toEqual([[one], [two]]);
  // A pin that fails to load keeps the rows already shown.
  fail = true;
  rerender({ ids: [two, one] });
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.rows.map((row) => row.id)).toEqual([one]);
});

it("reloads only the pin an edit or a withdrawn edit names", async () => {
  vi.useFakeTimers();
  try {
    const editId = "e".repeat(64);
    let content = "before";
    const s = source(async ([filter]) => {
      if (filter?.ids) return filter.ids.map((id) => message(id));
      return content === "before" || !filter?.["#e"]?.includes(one)
        ? []
        : [
            {
              ...message(editId, content),
              kind: 40003,
              created_at: 101,
              tags: [
                ["h", "c"],
                ["e", one],
              ],
            },
          ];
    });
    const { result } = renderHook(() =>
      usePinnedRows(s.value, "c", [one, two]),
    );
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.status).toBe("ready");
    content = "after";
    const edit = {
      ...message("f".repeat(64)),
      kind: 40003,
      tags: [["e", one]],
    };
    // A burst of edits is one read of the pin they name.
    act(() => s.deliver([edit]));
    act(() => s.deliver([edit]));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.rows[0]?.content).toBe("after");
    expect(idsRead(s)).toEqual([[one, two], [one]]);
    // An edit of another message, or a deletion of anything but a loaded
    // edit, reads nothing.
    const deletion = (target: string) => ({
      ...message("9".repeat(64)),
      kind: 5,
      tags: [
        ["h", "c"],
        ["e", target],
      ],
    });
    act(() =>
      s.deliver([
        { ...edit, tags: [["e", "3".repeat(64)]] },
        deletion("4".repeat(64)),
      ]),
    );
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(idsRead(s)).toHaveLength(2);
    content = "before";
    act(() => s.deliver([deletion(editId)]));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.rows[0]?.content).toBe("1");
    expect(idsRead(s)).toEqual([[one, two], [one], [one]]);
  } finally {
    vi.useRealTimers();
  }
});

it("reloads every row when its channel catches up", async () => {
  const s = source(async ([filter]) =>
    filter?.ids ? filter.ids.map((id) => message(id)) : [],
  );
  const { result } = renderHook(() => usePinnedRows(s.value, "c", [one, two]));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  // Another channel's catch-up reads nothing.
  act(() => s.catchUp("other"));
  expect(idsRead(s)).toEqual([[one, two]]);
  act(() => s.catchUp("c"));
  await waitFor(() => expect(idsRead(s)).toHaveLength(2));
  expect(idsRead(s)[1]).toEqual([one, two]);
});

it("reloads a pin when its agent's owner becomes known", async () => {
  const owner = "d".repeat(64);
  const s = source(async ([filter]) =>
    filter?.ids
      ? filter.ids.map((id) => message(id))
      : [
          {
            ...message("e".repeat(64), "fixed by owner"),
            pubkey: owner,
            kind: 40003,
            created_at: 101,
            tags: [
              ["h", "c"],
              ["e", one],
            ],
          },
        ],
  );
  const { result } = renderHook(() => usePinnedRows(s.value, "c", [one, two]));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  // Not yet known as the agent's owner, the edit does not apply.
  expect(result.current.rows[0]?.content).toBe("1");
  act(() => s.learnOwner("x".repeat(64), owner));
  act(() => s.learnOwner(author, owner));
  await waitFor(() =>
    expect(result.current.rows[0]?.content).toBe("fixed by owner"),
  );
  // Another agent's owner reads nothing; this one's reads its pins again.
  expect(idsRead(s)).toEqual([
    [one, two],
    [one, two],
  ]);
});

it("retries a failed refresh in the background, keeping the loaded rows", async () => {
  vi.useFakeTimers();
  try {
    let reply: () => readonly EventData[] = () => [message(one, "before")];
    const s = source(async ([filter]) => (filter?.ids ? reply() : []));
    const { result } = renderHook(() => usePinnedRows(s.value, "c", [one]));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows[0]?.content).toBe("before");
    reply = () => {
      throw new Error("offline");
    };
    act(() => s.catchUp("c"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.status).toBe("error");
    expect(result.current.rows[0]?.content).toBe("before");
    // Backoff: no read before the first delay's jittered floor, one by its
    // ceiling, and the next waits about twice as long.
    reply = () => {
      throw new Error("still offline");
    };
    await act(() => vi.advanceTimersByTimeAsync(2_400));
    expect(idsRead(s)).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(2_700));
    expect(idsRead(s)).toHaveLength(3);
    reply = () => [message(one, "after")];
    await act(() => vi.advanceTimersByTimeAsync(10_100));
    expect(idsRead(s)).toHaveLength(4);
    expect(result.current).toMatchObject({ status: "ready" });
    expect(result.current.rows[0]?.content).toBe("after");
  } finally {
    vi.useRealTimers();
  }
});

it("holds triggers that arrive during a read for one read after it", async () => {
  const gates: (() => void)[] = [];
  const s = source(async ([filter]) => {
    if (filter?.ids) await new Promise<void>((resolve) => gates.push(resolve));
    return filter?.ids ? filter.ids.map((id) => message(id)) : [];
  });
  const { result, rerender } = renderHook(
    ({ attempt }) => usePinnedRows(s.value, "c", [one, two], attempt),
    { initialProps: { attempt: 0 } },
  );
  await waitFor(() => expect(gates).toHaveLength(1));
  rerender({ attempt: 1 });
  act(() =>
    s.deliver([
      { ...message("f".repeat(64)), kind: 40003, tags: [["e", one]] },
    ]),
  );
  try {
    expect(gates).toHaveLength(1);
  } finally {
    act(() => gates.shift()?.());
  }
  await waitFor(() => expect(gates).toHaveLength(1));
  act(() => gates.shift()?.());
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(idsRead(s)).toEqual([
    [one, two],
    [one, two],
  ]);
});

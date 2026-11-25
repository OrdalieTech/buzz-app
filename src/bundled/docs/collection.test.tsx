// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { workspaceFixture, gate } from "./ui-testing";
import { useDocsCollection } from "./collection";
import { DOC_KIND, docTemplate, docUrl } from "./model";
import { signed } from "../../features/relay/testing";
import { eventDto } from "../../features/relay/events";

async function fixture(loseAtFollow = false) {
  let lost: string | undefined;
  let hidden: string | undefined;
  const f = await workspaceFixture({ live: true }, (session) =>
    !loseAtFollow
      ? session
      : {
          ...session,
          channels: {
            ...session.channels,
            get: (id) =>
              id === hidden ? undefined : session.channels.get?.(id),
          },
          artifacts: {
            ...session.artifacts,
            follow(ids, listener, revoked) {
              // Model a host access loss after the list's last check, before following.
              if (ids.includes(lost ?? "")) hidden = lost;
              return session.artifacts.follow(ids, listener, revoked);
            },
          },
        },
  );
  const mine = f.seed("My plan", "Keep");
  const shared = f.seed("Shared source", `[Plan](<${docUrl(mine, f.origin)}>)`);
  const storage = f.channels.get(shared.channel);
  if (!storage) throw new Error("Missing storage");
  storage.creator = f.sam.pubkey;
  storage.roles = { [f.sam.pubkey]: "owner", [f.viewer.pubkey]: "guest" };
  if (loseAtFollow) lost = shared.channel;
  const view = renderHook(() => useDocsCollection(f.workspace));
  await waitFor(() =>
    expect(view.result.current.collection.docs).toHaveLength(
      loseAtFollow ? 1 : 2,
    ),
  );
  const roster = (include: boolean, at = 2_000_000_000 + (include ? 0 : 1)) =>
    f.deliver(
      eventDto(
        signed(f.relay, {
          kind: 39002,
          created_at: at,
          content: "",
          tags: [
            ["d", shared.channel],
            ["t", "system"],
            ["p", f.sam.pubkey, "", "owner"],
            ...(include ? [["p", f.viewer.pubkey, "", "guest"]] : []),
          ],
        }),
      ),
    );
  await act(async () => roster(true));
  return { ...f, ...view, mine, shared, storage, roster };
}

it("reconciles multiple changed catalogue heads in a single background read", async () => {
  const reads = vi.fn();
  const f = await workspaceFixture({ live: true }, (session) => ({
    ...session,
    snapshotRead: async (filters, options) => {
      reads(filters, options);
      if (!session.snapshotRead) throw new Error("Missing relay read");
      return session.snapshotRead(filters, options);
    },
  }));
  const first = f.seed("First", "Original");
  const second = f.seed("Second", "Original");
  const view = renderHook(() => useDocsCollection(f.workspace));
  await waitFor(() =>
    expect(f.liveChannels()).toEqual(
      expect.arrayContaining([first.channel, second.channel]),
    ),
  );
  const events = await Promise.all(
    [first, second].map((doc) =>
      f.edit(f.viewer, doc, { title: doc.title, markdown: "Updated" }),
    ),
  );
  reads.mockClear();
  await act(async () => f.deliverBatch(events.map(eventDto)));
  await waitFor(() =>
    expect(view.result.current.collection.docs).toEqual([
      expect.objectContaining({ markdown: "Updated" }),
      expect.objectContaining({ markdown: "Updated" }),
    ]),
  );
  expect(reads).toHaveBeenCalledExactlyOnceWith(
    [
      expect.objectContaining({
        kinds: [DOC_KIND],
        "#h": expect.arrayContaining([first.channel, second.channel]),
        "#d": expect.arrayContaining([first.id, second.id]),
        consistency: "strong",
      }),
    ],
    expect.objectContaining({ priority: "background" }),
  );
});

it("drops access lost between the finite read and follower attachment", async () => {
  const f = await fixture(true);
  expect(f.result.current.collection.docs.map((doc) => doc.id)).toEqual([
    f.mine.id,
  ]);
  expect(f.liveChannels()).not.toContain(f.shared.channel);
});

it("follows unopened catalogue heads, retains tombstones for the Trash filter, and releases routes", async () => {
  const f = await fixture();
  expect(f.liveChannels()).toEqual(
    expect.arrayContaining([f.mine.channel, f.shared.channel]),
  );
  const change = await f.edit(f.sam, f.shared, {
    title: "Updated source",
    markdown: "New body",
  });
  await act(async () => f.deliver(eventDto(change)));
  await waitFor(() =>
    expect(f.result.current.collection.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Updated source",
          markdown: "New body",
        }),
      ]),
    ),
  );
  const current = await f.workspace.open(f.shared);
  const deleted = await f
    .client(f.sam)
    .publish(
      docTemplate(current, { title: "", markdown: "" }, current, "delete"),
    );
  await act(async () => f.deliver(eventDto(deleted)));
  await waitFor(() =>
    expect(
      f.result.current.collection.docs.find((doc) => doc.id === f.shared.id)
        ?.deleted,
    ).toBe(true),
  );
  const read = vi
    .spyOn(f.workspace, "reconcile")
    .mockRejectedValueOnce(new Error("Read unavailable"));
  // A failed fresh access read cannot retain the old cached title/body.
  await act(async () => f.roster(true, 2_000_000_002));
  await waitFor(() => expect(f.result.current.collection.docs).toHaveLength(1));
  read.mockRestore();
  await act(async () => f.result.current.load());
  expect(f.result.current.collection.docs).toHaveLength(2);
  f.unmount();
  expect(f.liveChannels()).not.toContain(f.mine.channel);
  expect(f.liveChannels()).not.toContain(f.shared.channel);
});

it.each([false, true])(
  "evicts revoked content and rejects an older in-flight list (more=%s)",
  async (more) => {
    const f = await fixture();
    const stale = f.result.current.collection;
    const pending = gate();
    let signal: AbortSignal | undefined;
    vi.spyOn(f.workspace, "list").mockImplementationOnce(
      async (_cursor, caller) => {
        signal = caller;
        await pending.promise;
        return stale;
      },
    );
    let loading!: Promise<void>;
    act(() => {
      loading = f.result.current.load(more);
    });
    act(() => f.result.current.remove([crypto.randomUUID()]));
    expect(signal?.aborted).toBe(false);
    try {
      delete f.storage.roles[f.viewer.pubkey];
      await act(async () => f.roster(false));
      await waitFor(() =>
        expect(f.result.current.collection.docs.map((doc) => doc.id)).toEqual([
          f.mine.id,
        ]),
      );
      expect(signal?.aborted).toBe(true);
      act(() => f.result.current.changed(f.shared));
    } finally {
      await act(async () => {
        pending.release();
        await loading;
      });
    }
    expect(f.result.current.collection.docs.map((doc) => doc.id)).toEqual([
      f.mine.id,
    ]);
    expect(f.result.current.loading).toBe(false);
    expect(f.liveChannels()).not.toContain(f.shared.channel);
  },
);

it("discards a changed head whose fresh read finishes after revocation", async () => {
  const f = await fixture();
  const pending = gate();
  const read = vi
    .spyOn(f.workspace, "reconcile")
    .mockImplementationOnce(async () => {
      await pending.promise;
      return [f.shared];
    });
  const event = await f.edit(f.sam, f.shared, {
    title: "New head",
    markdown: "Private",
  });
  await act(async () => f.deliver(eventDto(event)));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  const extra = f.seed("Next page", "Keep too");
  vi.spyOn(f.workspace, "list").mockResolvedValueOnce({
    docs: [extra],
    more: false,
  });
  await act(async () => f.result.current.load(true));
  expect(read.mock.calls[0]?.[1]?.aborted).toBe(false);
  try {
    delete f.storage.roles[f.viewer.pubkey];
    await act(async () => f.roster(false));
    await waitFor(() =>
      expect(f.result.current.collection.docs).toHaveLength(2),
    );
    // The shared batch may still serve other readable docs when this one is revoked.
  } finally {
    await act(async () => {
      pending.release();
      await read.mock.results[0]?.value;
    });
  }
  expect(f.result.current.collection.docs.map((doc) => doc.id)).toEqual([
    f.mine.id,
    extra.id,
  ]);
});

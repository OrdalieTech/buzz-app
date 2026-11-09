import { expect, it, vi } from "vitest";
import type {
  ArtifactEntry,
  HostArtifactCollection,
} from "../artifact-storage/types";
import {
  reconcileArtifactDelta,
  reconcileArtifactCurrent,
} from "./artifact-reconcile";
import {
  ArtifactIncrementalError,
  createArtifactIncrementalReader,
  type ArtifactIncrementalReader,
} from "./artifact-incremental-reader";
import { keypair, signed } from "./testing";
import { eventDto } from "./events";
const channel = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const event = eventDto(
  signed(keypair(), {
    kind: 45010,
    content: "{}",
    tags: [
      ["ar", "1"],
      ["d", id],
      ["h", channel],
      ["type", "test.task"],
      ["op", "create"],
    ],
  }),
);
const old = JSON.stringify({ protocol: "incremental-v1", checkpoint: "old" });
function setup(checkpoint: string | null = old) {
  const rows = new Map<string, ArtifactEntry>();
  const controller = new AbortController();
  const collection = {
    checkpoint: vi.fn(async () => checkpoint),
    beginRefresh: vi.fn(async (source: string) => ({
      source,
      generation: "generation",
    })),
    setRefreshError: vi.fn(async () => {}),
    get: vi.fn(async (id: string) => rows.get(id)),
    knownIds: vi.fn<HostArtifactCollection["knownIds"]>(
      async ({ channelId, after, limit }) => {
        const ids = [...rows]
          .filter(([, row]) => !channelId || row.record.channelId === channelId)
          .map(([key]) => key)
          .sort()
          .filter((key) => after === undefined || key > after);
        const page = ids.slice(0, limit);
        const next = ids.length > page.length ? page.at(-1) : undefined;
        return {
          ids: page,
          ...(next !== undefined ? { next } : {}),
        };
      },
    ),
    applyBatch: vi.fn<HostArtifactCollection["applyBatch"]>(async (batch) => {
      for (const item of batch.records ?? [])
        rows.set(item.id, {
          record: {
            id: item.id,
            channelId: item.channelId,
            current: item.revision,
            availability: { state: "unknown" },
          },
        });
      for (const item of batch.availability ?? []) {
        const row = rows.get(item.id);
        if ((row?.record.current?.id ?? null) !== item.expectedRevision)
          throw new Error("Artifact revision changed");
        if (row)
          rows.set(item.id, {
            ...row,
            record: { ...row.record, availability: item.value },
          });
      }
    }),
    completeRefresh: vi.fn(async () => {}),
  };
  const page = {
    version: 1 as const,
    startedAt: "2026-10-21T12:00:00.000001Z",
    overlapSeconds: 120 as const,
    changes: [],
    nextCursor: null,
    checkpoint: "next",
  };
  const reader = {
    delta: vi.fn<ArtifactIncrementalReader["delta"]>(async () => page),
    current: vi.fn<ArtifactIncrementalReader["current"]>(
      async (_query, ids) => ({
        version: 1,
        startedAt: page.startedAt,
        changes: ids.map((artifactId) => ({ type: "remove", artifactId })),
      }),
    ),
  };
  const host = collection as unknown as HostArtifactCollection;
  return {
    rows,
    collection,
    reader,
    page,
    controller,
    delta: () =>
      reconcileArtifactDelta(reader, host, "test.task", controller.signal),
    current: (ids: string[]) =>
      reconcileArtifactCurrent(
        reader,
        host,
        "test.task",
        ids,
        controller.signal,
      ),
  };
}
it("saves delta progress only after all pages commit", async () => {
  const h = setup();
  h.reader.delta.mockResolvedValueOnce({
    ...h.page,
    changes: [{ type: "upsert", artifactId: id, event }],
    nextCursor: "second",
    checkpoint: null,
  });
  await h.delta();
  expect(h.reader.delta.mock.calls[1]?.[1]).toEqual({
    cursor: "second",
  });
  expect(h.collection.applyBatch.mock.invocationCallOrder[0]).toBeLessThan(
    h.collection.completeRefresh.mock.invocationCallOrder[0] as number,
  );
  expect(h.collection.completeRefresh).toHaveBeenCalledWith(
    expect.objectContaining({ generation: "generation" }),
    {
      expected: old,
      next: JSON.stringify({ protocol: "incremental-v1", checkpoint: "next" }),
    },
    h.controller.signal,
  );
});
it("continues an incremental pass through the relay request validator", async () => {
  const h = setup();
  const request = vi.fn(
    async (
      filter: import("./artifact-incremental-reader").ArtifactIncrementalRequest,
    ) => {
      if ("checkpoint" in filter && "cursor" in filter)
        return Response.json({ code: "incremental_invalid" }, { status: 400 });
      if ("cursor" in filter)
        return Response.json({
          ...h.page,
          changes: [{ type: "remove", artifactId: id }],
        });
      return Response.json({
        ...h.page,
        changes: [{ type: "upsert", artifactId: id, event }],
        nextCursor: "second",
        checkpoint: null,
      });
    },
  );
  await reconcileArtifactDelta(
    createArtifactIncrementalReader(request),
    h.collection as unknown as HostArtifactCollection,
    "test.task",
    h.controller.signal,
  );
  expect(request.mock.calls.map(([filter]) => filter)).toEqual([
    {
      artifact: "incremental",
      query: { artifact: "current", kinds: [45010], "#type": ["test.task"] },
      checkpoint: "old",
    },
    {
      artifact: "incremental",
      query: { artifact: "current", kinds: [45010], "#type": ["test.task"] },
      cursor: "second",
    },
  ]);
  expect(h.rows.get(id)?.record.availability.state).toBe("unavailable");
  expect(h.collection.completeRefresh).toHaveBeenCalledOnce();
});
it("does not infer absence from an empty delta", async () => {
  const h = setup();
  h.rows.set(id, {
    record: {
      id,
      current: { id: "older", content: "saved" },
      availability: { state: "available" },
    },
  });
  await h.delta();
  expect(h.rows.get(id)?.record.availability.state).toBe("available");
  expect(h.reader.current).not.toHaveBeenCalled();
  expect(h.collection.knownIds).not.toHaveBeenCalled();
});
it("removes a locally observed revision after missed intermediate changes", async () => {
  const h = setup();
  h.rows.set(id, {
    record: {
      id,
      current: { id: "locally-observed", content: "saved" },
      availability: { state: "available" },
    },
    preference: { pinned: false },
  });
  h.reader.delta.mockResolvedValue({
    ...h.page,
    changes: [{ type: "remove", artifactId: id }],
  });
  await h.delta();
  expect(h.collection.applyBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      availability: [
        {
          id,
          expectedRevision: "locally-observed",
          value: { state: "unavailable" },
        },
      ],
    }),
    h.controller.signal,
  );
  expect(h.rows.get(id)).toMatchObject({
    preference: { pinned: false },
    record: {
      current: { content: "saved" },
      availability: { state: "unavailable" },
    },
  });
});
it.each(["page", "commit"])(
  "keeps progress after a failed %s",
  async (failure) => {
    const h = setup();
    h.reader.delta.mockResolvedValueOnce({
      ...h.page,
      changes: [{ type: "upsert", artifactId: id, event }],
      nextCursor: "second",
      checkpoint: null,
    });
    if (failure === "page")
      h.reader.delta.mockRejectedValueOnce(new Error("Disconnected"));
    else
      h.collection.applyBatch.mockRejectedValueOnce(
        new Error("Artifact revision changed"),
      );
    await expect(h.delta()).rejects.toThrow();
    expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  },
);
it.each(["policy_changed", "checkpoint_expired"])(
  "recovers %s with bootstrap and known-ID reads before progress",
  async (reason) => {
    const h = setup();
    h.rows.set("imported", {
      record: {
        id: "imported",
        local: { title: "Local" },
        availability: { state: "unknown" },
      },
    });
    h.reader.delta.mockRejectedValueOnce(
      new ArtifactIncrementalError(
        "incremental_reset",
        "Reset",
        reason as "policy_changed" | "checkpoint_expired",
      ),
    );
    await h.delta();
    expect(h.reader.delta.mock.calls[1]?.[1]).toEqual({
      checkpoint: undefined,
      cursor: undefined,
    });
    expect(h.reader.current.mock.calls[0]?.[1]).toEqual(["imported"]);
    expect(h.reader.current.mock.invocationCallOrder[0]).toBeLessThan(
      h.collection.completeRefresh.mock.invocationCallOrder[0] as number,
    );
    expect(h.rows.get("imported")?.record.availability.state).toBe(
      "unavailable",
    );
  },
);
it.each(["success", "bootstrap failure", "revalidation failure"])(
  "recovers a rejected saved checkpoint with %s",
  async (outcome) => {
    const h = setup();
    h.rows.set(id, { record: { id, availability: { state: "available" } } });
    const requests: import("./artifact-incremental-reader").ArtifactIncrementalRequest[] =
      [];
    const reader = createArtifactIncrementalReader(async (filter) => {
      requests.push(filter);
      if ("checkpoint" in filter || outcome === "bootstrap failure")
        return Response.json({ code: "incremental_invalid" }, { status: 400 });
      if ("action" in filter) {
        if (outcome === "revalidation failure")
          return Response.json(
            { code: "incremental_unavailable" },
            { status: 503 },
          );
        return Response.json({
          ...h.page,
          changes: [{ type: "remove", artifactId: id }],
        });
      }
      return Response.json(h.page);
    });
    const pass = reconcileArtifactDelta(
      reader,
      h.collection as unknown as HostArtifactCollection,
      "test.task",
      h.controller.signal,
    );
    if (outcome === "success") {
      await pass;
      expect(h.rows.get(id)?.record.availability.state).toBe("unavailable");
      expect(h.collection.completeRefresh).toHaveBeenCalledWith(
        expect.anything(),
        {
          expected: old,
          next: JSON.stringify({
            protocol: "incremental-v1",
            checkpoint: "next",
          }),
        },
        h.controller.signal,
      );
    } else {
      await expect(pass).rejects.toBeInstanceOf(ArtifactIncrementalError);
      expect(h.collection.completeRefresh).not.toHaveBeenCalled();
      expect(h.rows.get(id)?.record.availability.state).toBe("available");
    }
    expect(
      requests.map((request) =>
        "checkpoint" in request
          ? "saved"
          : "action" in request
            ? "current"
            : "fresh",
      ),
    ).toEqual(
      outcome === "bootstrap failure"
        ? ["saved", "fresh"]
        : ["saved", "fresh", "current"],
    );
  },
);
it.each(["cursor", "response", "request"])(
  "does not reset an invalid %s",
  async (failure) => {
    const h = setup();
    const request = vi.fn(
      async (
        filter: import("./artifact-incremental-reader").ArtifactIncrementalRequest,
      ) => {
        if (failure === "response") return Response.json({ version: 1 });
        if ("checkpoint" in filter)
          return Response.json({
            ...h.page,
            nextCursor: "second",
            checkpoint: null,
          });
        return Response.json({ code: "incremental_invalid" }, { status: 400 });
      },
    );
    const reader =
      failure === "request"
        ? h.reader
        : createArtifactIncrementalReader(request);
    if (failure === "request")
      h.reader.delta.mockRejectedValue(
        new ArtifactIncrementalError("incremental_invalid", "Invalid request"),
      );
    await expect(
      reconcileArtifactDelta(
        reader,
        h.collection as unknown as HostArtifactCollection,
        "test.task",
        h.controller.signal,
      ),
    ).rejects.toMatchObject({ code: "incremental_invalid" });
    expect(
      failure === "request" ? h.reader.delta : request,
    ).toHaveBeenCalledTimes(failure === "cursor" ? 2 : 1);
    expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  },
);
it("keeps recovery incomplete after failed revalidation", async () => {
  const h = setup(null);
  h.rows.set(id, { record: { id, availability: { state: "available" } } });
  h.reader.current.mockRejectedValue(new Error("Disconnected"));
  await expect(h.delta()).rejects.toThrow("Disconnected");
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  expect(h.rows.get(id)?.record.availability.state).toBe("available");
});
it("revalidates saved IDs on the first pass and migrates an old checkpoint", async () => {
  const h = setup("old-snapshot-token");
  h.rows.set(id, { record: { id, availability: { state: "unknown" } } });
  await h.delta();
  expect(h.reader.delta.mock.calls[0]?.[1].checkpoint).toBeUndefined();
  expect(h.reader.current).toHaveBeenCalledOnce();
});
it("keeps a moved artifact when the old channel is removed later", async () => {
  const h = setup();
  const oldChannel = "33333333-3333-4333-8333-333333333333";
  h.rows.set(id, {
    record: { id, channelId: oldChannel, availability: { state: "available" } },
  });
  h.reader.delta.mockResolvedValue({
    ...h.page,
    changes: [
      { type: "upsert", artifactId: id, event },
      { type: "removeChannel", channelId: oldChannel },
    ],
  });
  await h.delta();
  expect(h.rows.get(id)?.record).toMatchObject({
    channelId: channel,
    availability: { state: "available" },
  });
});
it.each([100, 101, 201])(
  "removes %s saved channel records in batches of at most 100",
  async (count) => {
    const h = setup();
    for (let index = 0; index < count; index++) {
      const id = `saved-${String(index).padStart(3, "0")}`;
      h.rows.set(id, {
        record: {
          id,
          channelId: channel,
          current: { id: `revision-${id}`, content: "saved" },
          availability: { state: "available" },
        },
        preference: { pinned: true },
      });
    }
    h.reader.delta.mockResolvedValue({
      ...h.page,
      changes: [{ type: "removeChannel", channelId: channel }],
    });
    await h.delta();
    const batches = h.collection.applyBatch.mock.calls.map(([batch]) => batch);
    expect(batches.map((batch) => batch.availability?.length)).toEqual(
      count === 100 ? [100] : count === 101 ? [100, 1] : [100, 100, 1],
    );
    expect(batches.flatMap((batch) => batch.availability ?? [])).toEqual(
      [...h.rows.keys()].map((id) => ({
        id,
        expectedRevision: `revision-${id}`,
        value: { state: "unavailable" },
      })),
    );
    for (const row of h.rows.values()) {
      expect(row.record.availability.state).toBe("unavailable");
      expect(row.record.current?.content).toBe("saved");
      expect(row.preference).toEqual({ pinned: true });
    }
    expect(
      h.collection.applyBatch.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      h.collection.completeRefresh.mock.invocationCallOrder[0] as number,
    );
  },
);
it("keeps progress when a later channel removal batch fails", async () => {
  const h = setup();
  for (let index = 0; index < 101; index++) {
    const id = `saved-${String(index).padStart(3, "0")}`;
    h.rows.set(id, {
      record: { id, channelId: channel, availability: { state: "available" } },
    });
  }
  h.reader.delta.mockResolvedValue({
    ...h.page,
    changes: [{ type: "removeChannel", channelId: channel }],
  });
  const apply = h.collection.applyBatch;
  h.collection.applyBatch = vi
    .fn<HostArtifactCollection["applyBatch"]>()
    .mockImplementationOnce(apply)
    .mockRejectedValueOnce(new Error("Artifact revision changed"));
  await expect(h.delta()).rejects.toThrow("Artifact revision changed");
  expect(h.rows.get("saved-099")?.record.availability.state).toBe(
    "unavailable",
  );
  expect(h.rows.get("saved-100")?.record.availability.state).toBe("available");
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  expect(await h.collection.checkpoint()).toBe(old);
});
it("restores an upsert after removal of its old channel", async () => {
  const h = setup();
  h.rows.set(id, {
    record: { id, channelId: channel, availability: { state: "available" } },
  });
  h.reader.delta.mockResolvedValue({
    ...h.page,
    changes: [
      { type: "removeChannel", channelId: channel },
      { type: "upsert", artifactId: id, event },
    ],
  });
  await h.delta();
  expect(h.rows.get(id)?.record.availability.state).toBe("available");
});
it("does not advance delta progress or clear its error on a current read", async () => {
  const h = setup();
  await h.current([id]);
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  expect(h.collection.checkpoint).not.toHaveBeenCalled();
});
it.each(["delta", "current"] as const)(
  "reports unsupported scope on the first %s failure and preserves progress",
  async (operation) => {
    const h = setup();
    const error = new ArtifactIncrementalError(
      "incremental_unsupported_scope",
      "Unsupported scope",
    );
    h.reader[operation].mockRejectedValue(error);
    await expect(
      operation === "delta" ? h.delta() : h.current([id]),
    ).rejects.toBe(error);
    expect(h.reader[operation]).toHaveBeenCalledOnce();
    expect(h.collection.setRefreshError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ generation: "generation" }),
      "Could not refresh saved data",
      h.controller.signal,
    );
    expect(h.collection.completeRefresh).not.toHaveBeenCalled();
    expect(await h.collection.checkpoint()).toBe(old);
  },
);
it("splits a current batch on capacity and rejects an oversized single result", async () => {
  const h = setup();
  h.reader.current.mockImplementation(async (_query, ids) => {
    if (ids.length > 1)
      throw new ArtifactIncrementalError("incremental_limit", "Large");
    return {
      version: 1,
      startedAt: h.page.startedAt,
      changes: [{ type: "remove", artifactId: ids[0] as string }],
    };
  });
  await h.current([id, "imported"]);
  expect(h.reader.current).toHaveBeenCalledTimes(3);
  h.reader.current.mockRejectedValue(
    new ArtifactIncrementalError("incremental_limit", "Large"),
  );
  await expect(h.current([id])).rejects.toMatchObject({
    code: "incremental_limit",
  });
});
it("rejects repeated cursors and changed capture times", async () => {
  const h = setup();
  h.reader.delta.mockResolvedValue({
    ...h.page,
    nextCursor: "same",
    checkpoint: null,
  });
  await expect(h.delta()).rejects.toThrow("cursor repeats");
  h.reader.delta
    .mockReset()
    .mockResolvedValueOnce({
      ...h.page,
      nextCursor: "second",
      checkpoint: null,
    })
    .mockResolvedValue({ ...h.page, startedAt: "2026-10-21T12:00:01.000001Z" });
  await expect(h.delta()).rejects.toThrow("capture changes");
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
});
it("cancels before a late local completion", async () => {
  const h = setup();
  h.reader.delta.mockImplementation(async () => {
    h.controller.abort();
    return h.page;
  });
  await expect(h.delta()).rejects.toMatchObject({ name: "AbortError" });
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
});

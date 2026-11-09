import { expect, it, vi } from "vitest";
import {
  ARTIFACT_INCREMENTAL_LIMITS,
  ArtifactIncrementalError,
  artifactIncrementalCapability,
  artifactIncrementalFailure,
  createArtifactIncrementalReader,
  type ArtifactIncrementalQuery,
  type ArtifactIncrementalRequest,
} from "./artifact-incremental-reader";
import { hasEventProof } from "./events";
import { keypair, signed } from "./testing";

const artifactId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const startedAt = "2026-10-21T22:00:01.123456Z";
const query = {
  artifact: "current",
  kinds: [45010],
  "#type": ["test.task"],
} as const;
const author = keypair();
const signal = () => new AbortController().signal;
const tags = [
  ["ar", "1"],
  ["d", artifactId],
  ["h", channelId],
  ["type", "test.task"],
  ["op", "create"],
];
const revision = (eventTags = tags, kind = 45010) =>
  signed(author, { kind, content: "{}", tags: eventTags });
const page = (changes: unknown[] = []) => ({
  version: 1,
  startedAt,
  overlapSeconds: 120,
  changes,
  nextCursor: null,
  checkpoint: "checkpoint-final",
});

it("requires each advertised sync limit", () => {
  expect(
    artifactIncrementalCapability({
      artifacts: { incremental: ARTIFACT_INCREMENTAL_LIMITS },
    }),
  ).toBe(true);
  for (const key of Object.keys(ARTIFACT_INCREMENTAL_LIMITS)) {
    const limits: Record<string, unknown> = { ...ARTIFACT_INCREMENTAL_LIMITS };
    delete limits[key];
    expect(
      artifactIncrementalCapability({ artifacts: { incremental: limits } }),
    ).toBe(false);
  }
  expect(
    artifactIncrementalCapability({
      artifacts: {
        incremental: { ...ARTIFACT_INCREMENTAL_LIMITS, overlapSeconds: 60 },
      },
    }),
  ).toBe(false);
  expect(
    artifactIncrementalCapability({ supported_extensions: ["nip-ar"] }),
  ).toBe(false);
});
it("reads signed changes and gives a checkpoint only on the final page", async () => {
  const event = revision();
  const request = vi.fn(async (_filter: ArtifactIncrementalRequest) =>
    Response.json({
      ...page([
        { type: "upsert", artifactId, event },
        { type: "remove", artifactId: channelId },
        { type: "removeChannel", channelId },
      ]),
      nextCursor: "page-two",
      checkpoint: null,
    }),
  );
  const reader = createArtifactIncrementalReader(request);
  const first = await reader.delta(
    query,
    { checkpoint: "prior-checkpoint" },
    signal(),
  );
  expect(first).toMatchObject({
    startedAt,
    overlapSeconds: 120,
    nextCursor: "page-two",
    checkpoint: null,
  });
  expect(first.changes).toHaveLength(3);
  const change = first.changes[0];
  expect(change?.type).toBe("upsert");
  if (change?.type === "upsert") expect(hasEventProof(change.event)).toBe(true);
  request.mockImplementationOnce(async () => Response.json(page()));
  const last = await reader.delta(query, { cursor: "page-two" }, signal());
  expect(last.checkpoint).toBe("checkpoint-final");
  expect(request.mock.calls.map(([filter]) => filter)).toEqual([
    { artifact: "incremental", query, checkpoint: "prior-checkpoint" },
    {
      artifact: "incremental",
      query,
      cursor: "page-two",
    },
  ]);
});
it.each([
  { nextCursor: "more", checkpoint: "early-checkpoint" },
  { nextCursor: null, checkpoint: null },
  { nextCursor: "", checkpoint: null },
  { nextCursor: "bad cursor", checkpoint: null },
  { nextCursor: null, checkpoint: "\n" },
  { nextCursor: null, checkpoint: "x".repeat(4097) },
  { overlapSeconds: 119 },
  { version: 2 },
  {
    changes: Array.from({ length: 101 }, () => ({
      type: "remove",
      artifactId,
    })),
  },
])("rejects invalid page fields %j", async (fields) => {
  const reader = createArtifactIncrementalReader(async () =>
    Response.json({ ...page(), ...fields }),
  );
  await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
    code: "incremental_invalid",
  });
});
it.each([
  "2026-02-30T22:00:01.123456Z",
  "2026-10-21T24:00:01.123456Z",
  "2026-10-21T22:60:01.123456Z",
  "2026-10-21T22:00:01.Z",
  "2026-10-21T22:00:01.1234567890Z",
  "2026-10-21T22:00:01.123456",
  "2026-10-21T22:00:01.123456+24:00",
])("rejects invalid sync time %s", async (value) => {
  const reader = createArtifactIncrementalReader(async () =>
    Response.json({ ...page(), startedAt: value }),
  );
  await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
    code: "incremental_invalid",
  });
});
it.each([
  "2026-10-21T22:00:01Z",
  "2026-10-21T22:00:01.123Z",
  "2026-10-21T22:00:01.123456Z",
  "2026-10-21T22:00:01.123456789Z",
  "2024-02-29T22:00:01.123456+05:30",
])("accepts relay sync time %s", async (time) => {
  const reader = createArtifactIncrementalReader(async () =>
    Response.json({ ...page(), startedAt: time }),
  );
  expect((await reader.delta(query, {}, signal())).startedAt).toBe(time);
  const current = createArtifactIncrementalReader(async () =>
    Response.json({
      version: 1,
      startedAt: time,
      changes: [{ type: "remove", artifactId }],
    }),
  );
  expect((await current.current(query, [artifactId], signal())).startedAt).toBe(
    time,
  );
});
it.each(
  [
    tags.filter(([name]) => name !== "ar"),
    [...tags, ["d", artifactId]],
    tags.map((tag) => (tag[0] === "d" ? ["d", channelId] : tag)),
    tags.map((tag) => (tag[0] === "h" ? ["h", "invalid"] : tag)),
    tags.map((tag) => (tag[0] === "type" ? ["type", "other.type"] : tag)),
    tags.map((tag) => (tag[0] === "ar" ? ["ar", "2"] : tag)),
    tags.map((tag) => (tag[0] === "op" ? ["op", "delete"] : tag)),
    tags.map((tag) => (tag[0] === "op" ? ["op", "unknown"] : tag)),
    tags.map((tag) =>
      tag[0] === "type" ? ["type", "test.task", "extra"] : tag,
    ),
  ].map((eventTags) => ({ eventTags })),
)(
  "rejects signed events with invalid artifact tags %j",
  async ({ eventTags }) => {
    const reader = createArtifactIncrementalReader(async () =>
      Response.json(
        page([{ type: "upsert", artifactId, event: revision(eventTags) }]),
      ),
    );
    await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
      code: "incremental_invalid",
    });
  },
);
it("rejects a wrong event kind or a modified signed body", async () => {
  for (const event of [
    revision(tags, 9),
    { ...revision(), content: "modified" },
  ]) {
    const reader = createArtifactIncrementalReader(async () =>
      Response.json(page([{ type: "upsert", artifactId, event }])),
    );
    await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
      code: "incremental_invalid",
    });
  }
});
it.each([
  { type: "remove", artifactId: "local-id" },
  { type: "remove", artifactId: "00000000-0000-0000-0000-000000000000" },
  { type: "removeChannel", channelId: "local-channel" },
  { type: "unknown", artifactId },
])("rejects invalid delta identities %j", async (change) => {
  const reader = createArtifactIncrementalReader(async () =>
    Response.json(page([change])),
  );
  await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
    code: "incremental_invalid",
  });
});
it("requires one current result for each requested ID and accepts a uniform remove for a local ID", async () => {
  const event = revision();
  const request = vi.fn(async (_filter: ArtifactIncrementalRequest) =>
    Response.json({
      version: 1,
      startedAt,
      changes: [
        { type: "remove", artifactId: "local-id" },
        { type: "upsert", artifactId, event },
      ],
    }),
  );
  const rows = await createArtifactIncrementalReader(request).current(
    query,
    [artifactId, "local-id"],
    signal(),
  );
  expect(rows.changes).toHaveLength(2);
  expect(request.mock.calls[0]?.[0]).toEqual({
    artifact: "incremental",
    action: "current",
    query,
    artifactIds: [artifactId, "local-id"],
  });
});
it.each(
  [
    [],
    [
      { type: "remove", artifactId },
      { type: "remove", artifactId },
    ],
    [{ type: "remove", artifactId: channelId }],
    [{ type: "removeChannel", channelId }],
  ].map((rows) => ({ rows })),
)(
  "rejects missing, duplicate or unrelated current results %j",
  async ({ rows }) => {
    const reader = createArtifactIncrementalReader(async () =>
      Response.json({ version: 1, startedAt, changes: rows }),
    );
    await expect(
      reader.current(query, [artifactId], signal()),
    ).rejects.toMatchObject({ code: "incremental_invalid" });
  },
);
it.each(
  [
    [],
    [""],
    [artifactId, artifactId],
    ["é".repeat(129)],
    Array.from({ length: 101 }, (_, i) => `local-${i}`),
  ].map((ids) => ({ ids })),
)("rejects invalid current input before a request %j", async ({ ids }) => {
  const request = vi.fn();
  await expect(
    createArtifactIncrementalReader(request).current(query, ids, signal()),
  ).rejects.toMatchObject({ code: "incremental_invalid" });
  expect(request).not.toHaveBeenCalled();
});
it("admits 100 bounded current IDs", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `${i}-${"é".repeat(126)}`);
  const reader = createArtifactIncrementalReader(async () =>
    Response.json({
      version: 1,
      startedAt,
      changes: ids.map((artifactId) => ({ type: "remove", artifactId })),
    }),
  );
  expect((await reader.current(query, ids, signal())).changes).toHaveLength(
    100,
  );
});
it.each([
  { ...query, "#type": [] },
  { ...query, "#type": ["one", "two"] },
  { ...query, "#type": [""] },
  { ...query, kinds: [9] },
  { ...query, "#h": [channelId] },
])("rejects unsupported queries before a request %j", async (value) => {
  const request = vi.fn();
  await expect(
    createArtifactIncrementalReader(request).delta(
      value as ArtifactIncrementalQuery,
      {},
      signal(),
    ),
  ).rejects.toMatchObject({ code: "incremental_invalid" });
  expect(request).not.toHaveBeenCalled();
});
it.each([
  { checkpoint: "prior-checkpoint", cursor: "page-two" },
  { checkpoint: "" },
  { cursor: "has space" },
  { checkpoint: "x".repeat(4097) },
])("rejects invalid input tokens %j", async (position) => {
  const request = vi.fn();
  await expect(
    createArtifactIncrementalReader(request).delta(query, position, signal()),
  ).rejects.toMatchObject({ code: "incremental_invalid" });
  expect(request).not.toHaveBeenCalled();
});
it.each([
  "incremental_invalid",
  "incremental_limit",
  "incremental_reset",
  "incremental_unavailable",
] as const)("preserves error code %s without relay text", async (code) => {
  const reader = createArtifactIncrementalReader(async () =>
    Response.json(
      { code, reason: "policy_changed", error: "private relay detail" },
      { status: 409 },
    ),
  );
  await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
    code,
    reason: "policy_changed",
  });
  await expect(reader.delta(query, {}, signal())).rejects.not.toThrow(
    "private relay detail",
  );
  expect(
    artifactIncrementalFailure({ code, reason: "checkpoint_expired" }),
  ).toEqual({
    error: "Artifact sync request fails",
    code,
    reason: "checkpoint_expired",
  });
});
it("rejects unknown error metadata and hides request failures", async () => {
  expect(artifactIncrementalFailure({ code: "unknown" })).toBeUndefined();
  expect(
    artifactIncrementalFailure({
      code: "incremental_reset",
      reason: "unknown",
    }),
  ).toBeUndefined();
  const reader = createArtifactIncrementalReader(async () => {
    throw new Error("private transport detail");
  });
  await expect(reader.delta(query, {}, signal())).rejects.toBeInstanceOf(
    ArtifactIncrementalError,
  );
  await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
    code: "incremental_unavailable",
    message: "Artifact sync request fails",
  });
});
it.each(["not json", new Uint8Array([0xff])])(
  "rejects invalid response encoding",
  async (body) => {
    const reader = createArtifactIncrementalReader(
      async () => new Response(body),
    );
    await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
      code: "incremental_invalid",
    });
  },
);
it("bounds response bytes and cancels the stream", async () => {
  const cancel = vi.fn();
  const reader = createArtifactIncrementalReader(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(ARTIFACT_INCREMENTAL_LIMITS.responseBytes / 2),
            );
            controller.enqueue(
              new Uint8Array(ARTIFACT_INCREMENTAL_LIMITS.responseBytes / 2 + 1),
            );
          },
          cancel,
        }),
      ),
  );
  await expect(reader.delta(query, {}, signal())).rejects.toMatchObject({
    code: "incremental_limit",
  });
  expect(cancel).toHaveBeenCalledOnce();
});
it("fences cancellation before requests and during response consumption", async () => {
  const stopped = new AbortController();
  stopped.abort();
  const request = vi.fn();
  await expect(
    createArtifactIncrementalReader(request).delta(query, {}, stopped.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(request).not.toHaveBeenCalled();
  const controller = new AbortController();
  const cancel = vi.fn();
  const reader = createArtifactIncrementalReader(
    async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              controller.abort();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  await expect(
    reader.delta(query, {}, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledOnce();
});

import { expect, it } from "vitest";
import { validChannelCommand } from "./channel-commands.mjs";
const id = "11111111-1111-4111-8111-111111111111";
it("allows ordinary invitations with an optional participant or guest role", () => {
  const invite = {
    kind: 9000,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["p", "a".repeat(64)],
    ],
  };
  expect(validChannelCommand(invite)).toBe(true);
  expect(
    validChannelCommand({
      ...invite,
      tags: [...invite.tags, ["role", "member"]],
    }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...invite,
      tags: [...invite.tags, ["role", "guest"]],
    }),
  ).toBe(true);
  for (const role of ["owner", "admin", "bot", "Guest", ""]) {
    expect(
      validChannelCommand({
        ...invite,
        tags: [...invite.tags, ["role", role]],
      }),
    ).toBe(false);
  }
  expect(
    validChannelCommand({
      ...invite,
      tags: [...invite.tags, ["role", "admin"]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...invite, kind: 9001 })).toBe(false);
});

it("admits stream and NIP-CL system channel creation only", () => {
  const create = (type) => ({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "For You records"],
      ["visibility", "private"],
      ["channel_type", type],
      ["t", "for-you"],
    ],
  });
  expect(validChannelCommand(create("stream"))).toBe(true);
  expect(validChannelCommand(create("system"))).toBe(true);
  for (const type of ["dm", "forum", "session", "System", ""])
    expect(validChannelCommand(create(type))).toBe(false);
});

it("creates a Solo chat with its label, an optional description and lifetime", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["t", "buzz.solo"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["about", "Notes"], create.tags[4]],
    }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["ttl", "604800"], create.tags[4]],
    }),
  ).toBe(true);
  for (const [index, value] of [
    [3, "dm"],
    [1, " "],
  ]) {
    expect(
      validChannelCommand({
        ...create,
        tags: create.tags.map((tag, i) =>
          i === index ? [tag[0], value] : tag,
        ),
      }),
    ).toBe(false);
  }
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["p", "a".repeat(64), "wss://relay"]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...create, content: "extra" })).toBe(false);
});

it("accepts one trailing outbox identifier for invitations and rejects ambiguous envelopes", () => {
  const invite = (tags) => ({ kind: 9000, created_at: 1, content: "", tags });
  const h = ["h", id],
    p = ["p", "a".repeat(64)],
    client = ["client-id", id];
  expect(validChannelCommand(invite([h, p, client]))).toBe(true);
  expect(validChannelCommand(invite([h, p, ["role", "member"], client]))).toBe(
    true,
  );
  expect(validChannelCommand(invite([h, p, ["role", "guest"], client]))).toBe(
    true,
  );
  for (const tags of [
    [h, p, client, client],
    [client, h, p],
    [h, p, ["client-id", "invalid"]],
    [h, p, [...client, "extra"]],
    [h, p, ["role", "member", "extra"]],
    [h, p, ["role", "member"], ["role", "member"]],
  ])
    expect(validChannelCommand(invite(tags))).toBe(false);
});

it("signs a batch invitation of up to 100 distinct people without elevating roles", () => {
  const invite = (tags) => ({ kind: 9000, created_at: 1, content: "", tags });
  const h = ["h", id],
    client = ["client-id", id];
  const people = (count) =>
    Array.from({ length: count }, (_, index) => [
      "p",
      index.toString(16).padStart(64, "0"),
    ]);
  for (const role of [
    [],
    [["role", "member"]],
    [["role", "guest"]],
    [["role", "bot"]],
  ])
    expect(
      validChannelCommand(invite([h, ...people(100), ...role, client])),
    ).toBe(true);
  for (const tags of [
    [h, ...people(101)],
    [h, ...people(2), people(1)[0]],
    [h, ...people(2), ["role", "admin"]],
    [h, ...people(2), ["role", "owner"]],
    [h, ["role", "member"]],
    [h, people(1)[0], ["role", "bot"]],
    [h, people(2)[0], ["role", "member"], people(2)[1]],
    [h, ["p", "a".repeat(64), "admin"], ...people(1)],
  ])
    expect(validChannelCommand(invite(tags))).toBe(false);
});

it("allows bounded ordinary stream creation and rejects malformed TTL", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
      ["about", "Updates for the team"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  expect(
    validChannelCommand({ ...create, tags: create.tags.slice(0, 4) }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag) =>
        tag[0] === "about" ? ["about", "x".repeat(1001)] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["ttl", "604800"]],
    }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["ttl", "604800"]],
    }),
  ).toBe(true);
  for (const tags of [
    [...create.tags, ["buzz-space", "personal"]],
    [...create.tags.slice(0, 4), ["ttl", "60"], create.tags[4]],
    [...create.tags, ["about", "Again"]],
  ])
    expect(validChannelCommand({ ...create, tags })).toBe(false);
  for (const ttl of [
    "",
    "0",
    "01",
    "+1",
    "1\n",
    "-1",
    "forever",
    "2147483648",
  ]) {
    expect(
      validChannelCommand({
        ...create,
        tags: [...create.tags, ["ttl", ttl]],
      }),
    ).toBe(false);
  }
});

it("rejects every truncated mandatory creation-tag prefix", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
    ],
  };
  for (let length = 0; length < create.tags.length; length++)
    expect(
      validChannelCommand({ ...create, tags: create.tags.slice(0, length) }),
    ).toBe(false);
});

it("admits NIP-CL labels at the end of a channel creation, before the client id", () => {
  const create = (labels) => ({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Records"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "For You records"],
      ...labels,
      ["client-id", "22222222-2222-4222-8222-222222222222"],
    ],
  });
  expect(validChannelCommand(create([]))).toBe(true);
  expect(
    validChannelCommand(
      create([
        ["t", "for-you"],
        ["t", "app:records"],
      ]),
    ),
  ).toBe(true);
  for (const labels of [
    [["t", "system"]],
    [["t", "Upper"]],
    [["t", ""]],
    [
      ["t", "a"],
      ["t", "a"],
    ],
    [
      ["t", "a"],
      ["about", "late"],
    ],
    Array.from({ length: 9 }, (_, n) => ["t", `l${n}`]),
  ])
    expect(validChannelCommand(create(labels))).toBe(false);
});

it("allows a create to name up to 32 distinct first members after its labels", () => {
  const member = (n) => ["p", n.toString(16).padStart(64, "0")];
  const create = (tail) => ({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Chat"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["t", "buzz.solo"],
      ...tail,
      ["client-id", id],
    ],
  });
  const members = Array.from({ length: 32 }, (_, n) => member(n + 1));
  expect(validChannelCommand(create(members))).toBe(true);
  for (const tail of [
    [...members, member(33)],
    [member(1), member(1)],
    [["p", "A".repeat(64)]],
    [["p", member(1)[1], "extra"]],
    [member(1), ["t", "buzz.session.named"]],
  ])
    expect(validChannelCommand(create(tail))).toBe(false);
});

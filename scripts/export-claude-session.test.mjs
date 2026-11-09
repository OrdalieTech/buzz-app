import { expect, it } from "vitest";
import { buildClaude } from "./export-claude-session.mjs";
import { eventBody } from "../src/features/agent-harness/turn-records.ts";

const event = {
  id: "e".repeat(64),
  pubkey: "b".repeat(64),
  kind: 9,
  created_at: 1,
  content: "hi",
  tags: [],
};
const user = (body) => ({
  type: "user",
  timestamp: "2026-10-31T12:00:00Z",
  message: { role: "user", content: body },
});
// The request a turn shows, or undefined when it shows its whole body.
const shown = (body) => {
  const [row] = buildClaude([user(body)]).entries;
  return row.html.includes("Buzz turn") ? row.preview : undefined;
};

it("shows the request of an exact-record event, in a turn or a steer", () => {
  for (const tag of [
    "buzz-event",
    "new-message-arrived-while-you-were-working",
  ])
    expect(
      shown(
        `<context>\nChannel: dev\n</context>\n\n<${tag}>\n${eventBody(event, "fix <it>")}\n</${tag}>`,
      ),
    ).toBe("fix <it>");
});

it("shows a request holding a line or paragraph separator", () => {
  for (const request of ["a\u2028b", "a\u2029b"])
    expect(
      shown(`<buzz-event>\n${eventBody(event, request)}\n</buzz-event>`),
    ).toBe(request);
});

it("shows older events by their content", () => {
  expect(
    shown(
      '<buzz-event type="mention">\nContent: old one\nTags: []\n</buzz-event>',
    ),
  ).toBe("old one");
});

it("leaves a Request line in other text alone, and does not throw on one", () => {
  for (const body of [
    'please check\nRequest: "foo"\nthanks',
    'Request: "\\q"',
    `<buzz-event>\n{"id":"x"}\nRequest: "foo"\n</buzz-event>`,
    `<buzz-event>\n${JSON.stringify(event)}\nRequest: "\\q"\n</buzz-event>`,
  ]) {
    expect(shown(body)).toBeUndefined();
  }
});

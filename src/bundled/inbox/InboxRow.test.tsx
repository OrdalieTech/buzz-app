// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as content from "../../features/notifications/content";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import { foldMessages } from "../../features/relay/fold";
import type { InboxItem } from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { RelaySession } from "../../features/relay/session";
import { keypair, message, signed } from "../../features/relay/testing";
import { workflowLabel } from "../../features/relay/workflow-attribution";
import { InboxRowButton, ReactionRowButton, rowIdentity } from "./InboxRow";

vi.mock("../../features/notifications/content", async (load) => {
  const actual =
    await load<typeof import("../../features/notifications/content")>();
  return { ...actual, messagePreview: vi.fn(actual.messagePreview) };
});

afterEach(cleanup);

it("parses a row preview's Markdown once across renders", () => {
  const item = {
    id: "row",
    authorId: "a".repeat(64),
    createdAt: 1,
    messageIds: [],
    preview: "**cached** preview",
    previewMentions: { content: "**cached** preview", mentions: [] },
    unreadCount: 0,
    manual: false,
  } as unknown as InboxItem;
  const row = (time: string) => (
    <InboxRowButton
      item={item}
      identity={{ sender: "Sender", context: "Channel", profile: undefined }}
      session={{} as unknown as RelaySession}
      feed={{ incomplete: [] } as unknown as InboxFeedSnapshot}
      time={time}
    />
  );
  const view = render(row("now"));
  view.rerender(row("later"));
  view.unmount();
  const again = render(row("now"));
  expect(again.getByText("cached preview")).toBeInTheDocument();
  expect(content.messagePreview).toHaveBeenCalledOnce();
});

it("shows a preview's resolved mentions as chips", () => {
  const tomb = "c".repeat(64);
  const profiles = new Map([[tomb, { name: "tomb" }]]);
  const item = {
    id: "row",
    channelId: "room",
    authorId: "a".repeat(64),
    createdAt: 1,
    messageIds: [],
    preview: "ugh @tomb now getting",
    previewMentions: { content: "ugh @tomb now getting", mentions: [tomb] },
    unreadCount: 0,
    manual: false,
  } as unknown as InboxItem;
  const view = render(
    <InboxRowButton
      item={item}
      identity={{ sender: "Sender", context: "Channel", profile: undefined }}
      session={
        {
          profiles: { subscribe: () => () => {}, snapshot: () => profiles },
          channels: {
            list: () => ({ channels: [] }),
            subscribeList: () => () => {},
          },
        } as unknown as RelaySession
      }
      feed={{ incomplete: [] } as unknown as InboxFeedSnapshot}
      time="now"
      previewId="preview"
    />,
  );
  const preview = view.container.querySelector("#preview");
  expect(preview?.querySelector("[data-mention-kind]")).toHaveTextContent(
    "tomb",
  );
  expect(preview).toHaveTextContent("ugh tomb now getting");
  // Names built from the preview still say someone was mentioned.
  expect(view.getByRole("img", { name: "@" })).toBeInTheDocument();
});

const viewer = keypair(),
  alice = keypair(),
  bob = keypair(),
  namesake = keypair(),
  relay = keypair();
const profiles = new Map<string, Profile>([
  [alice.pubkey, { name: "Alice" }],
  [bob.pubkey, { name: "Bob" }],
  [namesake.pubkey, { name: "Alice" }],
  [relay.pubkey, { name: "Relay" }],
]);
const name = (_key: string, fallback: string) => fallback;
const emoji = { entries: [] };
const session = {
  media: () => undefined,
  emoji: {
    subscribe: () => () => {},
    snapshot: () => emoji,
    ensure: async () => {},
  },
} as unknown as RelaySession;
const dm = (...others: { pubkey: string }[]): ChannelSummary => ({
  id: "dm",
  name: "Direct message",
  channelType: "dm",
  participants: others.map((other) => other.pubkey),
});

it.each([
  {
    row: "a one-to-one DM's other member",
    channel: dm(alice),
    item: { authorId: alice.pubkey },
    expected: { sender: "Alice", context: "DM" },
  },
  {
    row: "a group DM's member",
    channel: dm(alice, bob),
    item: { authorId: alice.pubkey },
    expected: { sender: "Alice", context: "DM · Alice, Bob" },
  },
  {
    row: "another person with the name of a one-to-one DM's other member",
    channel: dm(alice),
    item: { authorId: namesake.pubkey },
    expected: { sender: "Alice", context: "DM · Alice" },
  },
  {
    row: "a workflow owned by a one-to-one DM's other member",
    channel: dm(alice),
    item: { authorId: relay.pubkey, workflowOwnerId: alice.pubkey },
    expected: { sender: workflowLabel("Alice"), context: "DM · Alice" },
  },
  {
    row: "a workflow signed by a one-to-one DM's other member",
    channel: dm(relay),
    item: { authorId: relay.pubkey, workflowOwnerId: alice.pubkey },
    expected: { sender: workflowLabel("Alice"), context: "DM · Relay" },
  },
])(
  "names a row from $row as $expected.context",
  ({ channel, item, expected }) => {
    expect(
      rowIdentity(item as InboxItem, channel, profiles, name),
    ).toMatchObject(expected);
  },
);

it.each([
  { place: "a one-to-one DM", channel: dm(alice), context: "in DM" },
  {
    place: "a group DM",
    channel: dm(alice, bob),
    context: "in DM with Alice, Bob",
  },
])(
  "places a reaction from a member of $place $context",
  async ({ channel, context }) => {
    const target = message(viewer, "dm", "My message", 1);
    const folded = foldMessages("dm", viewer.pubkey, [target])[0];
    if (!folded) throw new Error("Missing fixture message");
    const view = render(
      <ReactionRowButton
        item={{
          id: `reaction:${target.id}`,
          channelId: "dm",
          message: folded,
          createdAt: 2,
          events: [
            signed(alice, {
              kind: 7,
              content: "❤️",
              created_at: 2,
              tags: [["e", target.id]],
            }),
          ],
        }}
        session={session}
        profiles={profiles}
        name={name}
        channel={channel}
      />,
    );
    // The emoji's name loads after first render; the row is settled once it shows.
    await view.findByRole("button", {
      name: "Alice reacted with heart to your message: My message",
    });
    expect(view.getByText(context)).toBeInTheDocument();
  },
);

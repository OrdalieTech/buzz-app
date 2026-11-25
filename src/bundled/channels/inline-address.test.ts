import { describe, expect, it } from "vitest";
import {
  type OpenTarget,
  parseOpenTarget,
} from "../../features/navigation/targets";
import {
  type ConversationTarget,
  canonicalInline,
  inlineDismissal,
  inlineToTab,
  layerDismissal,
  layerVisit,
  routedInline,
} from "./inline-address";

const scope = {
  viewer: "a".repeat(64),
  communityOrigin: "https://example.org",
};
const root = "b".repeat(64);
const reply = "c".repeat(64);
const conversation: ConversationTarget = {
  version: 1,
  kind: "conversation",
  scope,
  channelId: "alpha",
};
const inline = { ...conversation, inline: root };
const elsewhere: OpenTarget = {
  ...conversation,
  channelId: "beta",
  inline: root,
};

describe("inline address", () => {
  it("closes the inline thread with a layer over it, keeping one over the conversation", () => {
    const over = { ...inline, layer: { messageId: reply, rootId: root } };
    const dismissal = inlineDismissal(over, root);
    expect(dismissal?.fallback).toEqual(conversation);
    expect(dismissal?.visits(over)).toBe(true);
    expect(dismissal?.visits(elsewhere)).toBe(false);
    expect(dismissal?.visits(conversation)).toBe(false);
    const beside = { ...inline, layer: { messageId: reply } };
    expect(inlineDismissal(beside, root)?.fallback).toEqual({
      ...conversation,
      layer: { messageId: reply },
    });
    expect(inlineDismissal(conversation, root)).toBeUndefined();
    // A thread opened at a linked reply closes to an address the navigator
    // accepts: the reply goes with the thread that named it.
    const atReply = { ...inline, inlineMessage: reply };
    const closed = inlineDismissal(atReply, root);
    expect(closed?.visits(atReply)).toBe(true);
    expect(parseOpenTarget(closed?.fallback)).toEqual(conversation);
  });

  it("renames a reply's inline visits to its root, and only when they differ", () => {
    const named = { ...conversation, inline: reply };
    const dismissal = canonicalInline(named, reply, root);
    expect(dismissal?.fallback).toEqual(inline);
    expect(dismissal?.visits(named)).toBe(true);
    // The linked reply stays named under its verified root.
    expect(
      canonicalInline({ ...named, inlineMessage: reply }, reply, root)
        ?.fallback,
    ).toEqual({ ...inline, inlineMessage: reply });
    expect(canonicalInline(inline, root, root)).toBeUndefined();
  });

  it("hands the inline thread to the visit of its tab", () => {
    expect(inlineToTab(inline, root)?.fallback).toEqual({
      ...conversation,
      messageId: root,
      threadRootId: root,
    });
    expect(inlineToTab(conversation, root)).toBeUndefined();
  });

  it("resolves a routed thread to its conversation with the thread inline at the linked reply", () => {
    expect(
      routedInline(
        { ...conversation, messageId: reply, threadRootId: root },
        root,
      ),
    ).toEqual({ ...inline, inlineMessage: reply });
    expect(
      routedInline(
        { ...conversation, messageId: root, threadRootId: root },
        root,
      ),
    ).toEqual(inline);
  });

  it("opens a layer over the view it came from and closes it to what was under it", () => {
    const pull = "https://github.com/example-org/project/pull/1";
    const overThread = layerVisit(inline, {
      channelId: "alpha",
      rootId: root,
      target: pull,
      threadId: root,
    });
    expect(overThread).toEqual({
      ...inline,
      layer: { target: pull, threadId: root, rootId: root },
    });
    // Over the conversation it replaces the inline thread.
    expect(
      layerVisit(inline, { channelId: "alpha", messageId: reply }),
    ).toEqual({ ...conversation, layer: { messageId: reply } });
    // A thread tab of another channel is named by its channel.
    expect(
      layerVisit(conversation, {
        channelId: "beta",
        rootId: root,
        messageId: reply,
      }).layer,
    ).toEqual({ messageId: reply, rootId: root, channelId: "beta" });
    const dismissal = layerDismissal(overThread);
    expect(dismissal?.fallback).toEqual(inline);
    expect(dismissal?.visits(overThread)).toBe(true);
    expect(dismissal?.visits(inline)).toBe(false);
    expect(layerDismissal(overThread, conversation)?.fallback).toEqual(
      conversation,
    );
    expect(layerDismissal(inline)).toBeUndefined();
    // A send made under details A is still publishing when the reader opens
    // details B: its closing names A, so B stays open.
    const a = { channelId: "alpha", messageId: root };
    const b = { channelId: "alpha", messageId: reply };
    const overA = layerVisit(conversation, a);
    const overB = layerVisit(conversation, b);
    expect(layerDismissal(overA, undefined, a)?.visits(overA)).toBe(true);
    expect(layerDismissal(overB, undefined, a)).toBeUndefined();
  });
});

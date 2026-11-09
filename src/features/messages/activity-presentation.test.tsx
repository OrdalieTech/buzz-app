// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import {
  activityPresentation,
  useChannelActivitySnapshot,
  useStableRowActivity,
  type ActivityRowPresentation,
} from "./activity-presentation";
import { useActivityIndicator } from "./use-activity-indicator";
import { useLiveConversationAgents } from "./TypingIndicator";
import {
  agent,
  entry,
  fixture,
  root,
  type Snapshot,
} from "./typing-indicator-testing";

afterEach(cleanup);

it("keeps row activity props identical while each projection's values are equal", () => {
  const { result } = renderHook(() => useStableRowActivity());
  const row = (active: boolean): ActivityRowPresentation => ({
    requestId: root,
    active,
    ownsLive: true,
    container: "bubble",
  });
  const first = result.current.activity("row", row(false), "history");
  expect(first).toEqual({ ...row(false), container: "history" });
  expect(result.current.activity("row", row(false), "history")).toBe(first);
  const changed = result.current.activity("row", row(true), "history");
  expect(changed).not.toBe(first);
  expect(changed?.active).toBe(true);
  expect(result.current.activity("row", row(true))).toEqual(row(true));
  expect(result.current.activity("row", undefined, "history")).toBeUndefined();

  const agents = result.current.agents("row", [agent]);
  expect(result.current.agents("row", [agent])).toBe(agents);
  expect(result.current.agents("row", [agent, "other"])).not.toBe(agents);
});

it("re-renders on typing and activity only for the row that owns the live signal", () => {
  const live = fixture();
  const row = {
    id: "update",
    channelId: "channel",
    threadRootId: root,
    authorId: agent,
  } as ChannelMessage;
  let renders = 0;
  const { rerender } = renderHook(
    ({ eligible }: { eligible: boolean }) => {
      renders++;
      return useActivityIndicator(live.session, row, eligible);
    },
    { initialProps: { eligible: false } },
  );
  const quiet = renders;
  live.update([entry()]);
  live.update([], { trimmed: 1 });
  expect(renders).toBe(quiet);

  rerender({ eligible: true });
  const owner = renders;
  live.update([entry()]);
  expect(renders).toBeGreaterThan(owner);
});

it("re-renders a live-agents host only when its working agents change", () => {
  const live = fixture();
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useLiveConversationAgents(live.session, "channel", root);
  });
  expect(result.current).toEqual([]);
  const idle = renders;
  live.update([{ pubkey: agent, channelId: "elsewhere", threadRootId: root }]);
  live.update([], { trimmed: 1 });
  expect(renders).toBe(idle);
  live.update([entry()]);
  expect(result.current).toEqual([agent]);
});

it("keeps a conversation's activity snapshot through other channels' work", () => {
  const live = fixture();
  const record = (id: string, channelId: string) =>
    Object.freeze({
      id,
      channelIds: Object.freeze([channelId]),
    }) as unknown as Snapshot["records"][number];
  const turn = (channelId: string, timestamp: number) =>
    ({ agent, turnId: "t", channelId, timestamp, state: "working" }) as const;
  const elsewhere = record("elsewhere", "other");
  const here = record("here", "channel");
  const channels = new Set(["channel"]);
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useChannelActivitySnapshot(live.session.agentActivity, channels);
  });
  const initial = result.current;
  const idle = renders;
  live.update([], { records: [elsewhere] });
  live.update([], { records: [elsewhere], turns: [turn("other", 1)] });
  live.update([], { records: [elsewhere], turns: [turn("other", 2)] });
  expect(renders).toBe(idle);
  expect(result.current).toBe(initial);
  live.update([], { records: [elsewhere, here] });
  expect(result.current?.records).toEqual([elsewhere, here]);
  const withRecord = result.current;
  live.update([], { records: [elsewhere, here], turns: [turn("channel", 3)] });
  expect(result.current).not.toBe(withRecord);
});

it("maps each request to its agents' latest public replies", () => {
  const message = (
    id: string,
    authorId: string,
    extra: Partial<ChannelMessage> = {},
  ) =>
    ({
      id,
      channelId: "channel",
      authorId,
      createdAt: 1,
      content: id,
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
      ...extra,
    }) as ChannelMessage;
  const human = "h".repeat(64);
  const { repliedAgents, replyRequests } = activityPresentation(
    [
      message("request", human),
      message("first", agent),
      message("update", agent, { audience: "agents" }),
      message("latest", agent),
      message("later", human),
    ],
    undefined,
    new Set([agent]),
  );
  expect(repliedAgents.get("request")).toEqual([agent]);
  expect(replyRequests.get("latest")).toBe("request");
  expect(replyRequests.has("first")).toBe(false);
  expect(replyRequests.has("update")).toBe(false);
  expect(repliedAgents.has("later")).toBe(false);
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import {
  keypair,
  message,
  profile,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { ThreadPanel } from "./ThreadPanel";
import { createAgentActivity } from "../agents/activity";
import { createLocalAgentActivity } from "../agents/local-activity";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";

stubAvatarBrowserApis();

vi.mock("./MessageMarkdown", () => ({
  MessageMarkdown: ({ row }: { row: ChannelMessage }) => (
    <span>{row.content}</span>
  ),
}));
vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));
vi.mock("./MediaAttachment", () => ({
  MediaAttachment: ({ seekTo }: { seekTo?: number }) => (
    <span data-testid="video-seek">{seekTo ?? "none"}</span>
  ),
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);

afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([false, true])(
  "retains rows and seeks timestamps with media viewer available=%s",
  async (viewerAvailable) => {
    const openMediaReview = vi.fn();
    const relay = keypair();
    const viewer = keypair();
    const aliceKey = keypair();
    const bobKey = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let traffic!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      query(filters, signal) {
        if (filters[0]?.kinds?.includes(30315)) return Promise.resolve([]);
        return wire.transport.query(filters, signal);
      },
      subscribe(callbacks) {
        traffic = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    const root = message(aliceKey, "a", "Root body", 1, [
      ["imeta", "url https://example.com/video.mp4", "m video/mp4"],
    ]);
    const reply = message(bobKey, "a", "⏱ 0:42 — Reply body", 2, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ]);
    traffic.receive([
      root,
      reply,
      profile(aliceKey, { name: "Alice" }),
      profile(bobKey, { name: "Bob" }),
    ]);
    const session = owner.session;

    render(
      <StrictMode>
        <ThreadPanel
          session={session}
          scope="identity-test"
          channelName="A"
          channelId="a"
          messageId={root.id}
          {...(viewerAvailable ? { onOpenMediaReview: openMediaReview } : {})}
          close={() => {}}
          onOpenLink={() => false}
        />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(wire.pending.some((request) => !request.signal?.aborted)).toBe(
        true,
      ),
    );
    const initial = wire.pending.find((request) => !request.signal?.aborted);
    if (!initial) throw new Error("Initial thread page was not requested");
    initial.respond([root, reply]);
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        wire.pending.filter(
          (request) => request !== initial && !request.signal?.aborted,
        ),
      ).toHaveLength(1),
    );
    const page = wire.pending.find(
      (request) => request !== initial && !request.signal?.aborted,
    );
    if (!page) throw new Error("Deferred thread page was not requested");
    expect(screen.queryByText("Loading thread…")).not.toBeInTheDocument();

    await act(async () => {
      traffic.receive([profile(keypair(), { name: "Other" })]);
    });

    const retainedReply = screen.getByText("Reply body");
    const retainedRow = retainedReply.closest("[data-message-id]");
    const appended = message(bobKey, "a", "Appended reply body", 3, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ]);
    await act(async () => page.respond([root, appended]));
    expect(await screen.findByText("Appended reply body")).toBeInTheDocument();
    // The previous last bubble joins the new same-author reply while its
    // mounted content stays intact.
    expect(screen.getByText("Reply body")).toBe(retainedReply);
    expect(retainedRow?.querySelector("[data-stack-next]")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "0:42" }));
    if (viewerAvailable) {
      expect(openMediaReview).toHaveBeenCalledExactlyOnceWith(
        root.id,
        expect.objectContaining({
          url: "https://example.com/video.mp4",
          kind: "video",
        }),
        39,
        true,
        undefined,
      );
    } else {
      expect(screen.getByTestId("video-seek")).toHaveTextContent("42");
    }

    const edited = signed(bobKey, {
      kind: 40003,
      content: "Edited reply body",
      created_at: 4,
      tags: [["e", reply.id]],
    });
    traffic.receive([edited]);
    expect(await screen.findByText("Edited reply body")).toBeInTheDocument();

    await act(async () => {
      traffic.receive([profile(bobKey, { name: "Robert" }, 1_700_000_001)]);
    });
    expect(await screen.findAllByText("Robert")).toHaveLength(2);
    owner.dispose();
  },
);

it("keeps a standalone activity root subscribed to its request through completion", async () => {
  const agent = keypair();
  const root = message(agent, "a", "Checking root activity", 1, [
    ["audience", "agents"],
  ]);
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
    query(filters, signal) {
      return filters[0]?.kinds?.includes(30315)
        ? Promise.resolve([])
        : wire.transport.query(filters, signal);
    },
  });
  traffic.receive([root]);
  const local = createLocalAgentActivity();
  const activity = createAgentActivity(
    true,
    () => {},
    () => true,
    undefined,
    undefined,
    { source: local.reader, scope: "root-test" },
  );
  const release = activity.queries.activate();
  const work = local.begin({
    scope: "root-test",
    agent: agent.pubkey,
    channelId: "a",
    messageId: root.id,
    threadRootId: root.id,
  });
  work.started();
  try {
    render(
      <ThreadPanel
        session={{ ...owner.session, agentActivity: activity.queries }}
        scope="activity-root-test"
        channelName="A"
        channelId="a"
        messageId={root.id}
        close={() => {}}
        onOpenLink={() => false}
      />,
    );
    const preview = await screen.findByText("Checking root activity");
    expect(preview).toHaveAttribute("data-active", "true");
    act(() => work.finish({ ok: true }));
    expect(preview).not.toHaveAttribute("data-active");
  } finally {
    cleanup();
    release();
    activity.dispose();
    owner.dispose();
  }
});

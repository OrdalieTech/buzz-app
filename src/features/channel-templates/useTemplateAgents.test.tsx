// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, signed, scriptedTransport } from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import { localAgentsFixture } from "../agents/local-testing";
import { useMentionArchives } from "../messages/use-mention-archives";
import { useTemplateAgents } from "./useTemplateAgents";
import { useAgentChoices } from "../agents/use-choices";
import { ReadError } from "../relay/errors";

afterEach(cleanup);

it.each(["mention", "template"] as const)(
  "%s demand claims a background admission retry during an outage",
  async (consumer) => {
    vi.useFakeTimers();
    const viewer = keypair(),
      relay = keypair(),
      agent = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const query = vi.fn(wire.transport.query);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        query,
        scope: "https://relay.example.test",
        archiveAuthority: relay.pubkey,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      {
        agentChoices: localAgentsFixture([
          {
            pubkey: agent.pubkey,
            name: "Template agent",
            relayUrl: "wss://relay.example.test",
            owner: viewer.pubkey,
          },
        ]),
      },
    );
    try {
      live.state({ status: "connected", routes: [] });
      const first = owner.session.archives.ensure({ background: true });
      wire.next().fail(new ReadError("unavailable", "quota", 429, 60_000));
      await first;
      const deadline = owner.session.archives.snapshot().retryAt;
      live.state({ status: "retrying", routes: [] });
      renderHook(() => {
        useMentionArchives(owner.session, consumer === "mention");
        useTemplateAgents(
          owner.session,
          consumer === "template"
            ? {
                id: "template",
                name: "Template",
                agents: [agent.pubkey],
                teams: [],
                canvas: "",
              }
            : undefined,
        );
      });
      await act(() => vi.advanceTimersByTimeAsync(59_999));
      expect(query).toHaveBeenCalledTimes(1);
      expect(owner.session.archives.snapshot().retryAt).toBe(deadline);
      for (let tick = 0; tick < 10 && !wire.pending.length; tick++)
        await act(() => vi.advanceTimersToNextTimerAsync());
      expect(Date.now()).toBeGreaterThanOrEqual(deadline ?? 0);
      expect(query).toHaveBeenCalledTimes(2);
      expect(wire.pending).toHaveLength(1);
      await act(async () => {
        wire
          .next()
          .respond([
            signed(relay, { kind: 13535, content: "", tags: [["-"]] }),
          ]);
        await owner.session.archives.ensure();
      });
      expect(owner.session.archives.snapshot().status).toBe("ready");
    } finally {
      cleanup();
      owner.dispose();
      vi.useRealTimers();
    }
  },
);

it("finishes template archive checks over HTTP during a socket-only outage", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const query = vi.fn(async () => [
    signed(relay, {
      kind: 13535,
      content: "",
      tags: [["-"]],
    }),
  ]);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      agentChoices: localAgentsFixture([
        {
          pubkey: agent.pubkey,
          name: "Template agent",
          relayUrl: "wss://relay.example.test",
          owner: viewer.pubkey,
        },
      ]),
    },
  );
  try {
    live.state({ status: "connected", routes: [] });
    live.state({ status: "retrying", routes: [] });
    const { result } = renderHook(() =>
      useTemplateAgents(owner.session, {
        id: "template",
        name: "Template",
        agents: [agent.pubkey],
        teams: [],
        canvas: "",
      }),
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.checking).toBe(false);
    expect(result.current.agents).toEqual([agent.pubkey]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(owner.session.live.snapshot().status).toBe("retrying");
  } finally {
    cleanup();
    act(() => owner.dispose());
  }
});

it.each(["mention", "template"] as const)(
  "%s demand joins a loading sidebar read before a socket drop",
  async (consumer) => {
    const viewer = keypair(),
      relay = keypair(),
      agent = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const query = vi.fn(wire.transport.query);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        query,
        scope: "https://relay.example.test",
        archiveAuthority: relay.pubkey,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      {
        agentChoices: localAgentsFixture([
          {
            pubkey: agent.pubkey,
            name: "Template agent",
            relayUrl: "wss://relay.example.test",
            owner: viewer.pubkey,
          },
        ]),
      },
    );
    const template = {
      id: "template",
      name: "Template",
      agents: [agent.pubkey],
      teams: [],
      canvas: "",
    };
    try {
      live.state({ status: "connected", routes: [] });
      const background = owner.session.archives.ensure({ background: true });
      const request = wire.next();
      const { result } = renderHook(() => {
        const archives = useMentionArchives(
          owner.session,
          consumer === "mention",
        );
        const agents = useTemplateAgents(
          owner.session,
          consumer === "template" ? template : undefined,
        );
        return consumer === "mention"
          ? archives.status === "ready"
          : !agents.pending && agents.agents.includes(agent.pubkey);
      });
      act(() => live.state({ status: "retrying", routes: [] }));
      expect(request.signal?.aborted).toBe(false);
      await act(async () => {
        request.respond([
          signed(relay, { kind: 13535, content: "", tags: [["-"]] }),
        ]);
        await background;
      });
      await waitFor(() => expect(result.current).toBe(true));
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      act(() => owner.dispose());
    }
  },
);

it("keeps template selection pending until a read held across reconnect is reread", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const isArchiveRead = (filters: readonly { kinds?: readonly number[] }[]) =>
    filters.some((filter) => filter.kinds?.includes(13535));
  // Only archive reads are scripted; other inventory settles empty at once.
  const query = vi.fn<typeof wire.transport.query>((filters, signal) =>
    isArchiveRead(filters)
      ? wire.transport.query(filters, signal)
      : Promise.resolve([]),
  );
  const archiveReads = () =>
    query.mock.calls.filter(([filters]) => isArchiveRead(filters)).length;
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      query,
      scope: "https://relay.example.test",
      archiveAuthority: relay.pubkey,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      agentChoices: localAgentsFixture([
        {
          pubkey: agent.pubkey,
          name: "Template agent",
          relayUrl: "wss://relay.example.test",
          owner: viewer.pubkey,
        },
      ]),
    },
  );
  try {
    live.state({ status: "connected", routes: [] });
    // No sidebar demand. An ordinary mention consumer settles inventory, so
    // only archive evidence can keep a New Workspace save waiting.
    const { result } = renderHook(() => {
      useAgentChoices(owner.session);
      return useTemplateAgents(owner.session, {
        id: "template",
        name: "Template",
        agents: [agent.pubkey],
        teams: [],
        canvas: "",
      });
    });
    await waitFor(() => expect(wire.pending).toHaveLength(1));
    await waitFor(() =>
      expect(owner.session.agentChoices.snapshot().pending).toBe(false),
    );
    const held = wire.next();
    act(() => {
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
    });
    // Inventory demand rereads after reconnect; let it settle first.
    await waitFor(() =>
      expect(owner.session.agentChoices.snapshot().pending).toBe(false),
    );
    // The held response predates an unarchive the socket did not deliver.
    await act(async () => {
      held.respond([
        signed(relay, {
          kind: 13535,
          content: "",
          tags: [["-"], ["p", agent.pubkey]],
          created_at: 1,
        }),
      ]);
    });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(wire.pending).toHaveLength(1));
    await act(async () => {
      wire.next().respond([
        signed(relay, {
          kind: 13535,
          content: "",
          tags: [["-"]],
          created_at: 2,
        }),
      ]);
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.agents).toEqual([agent.pubkey]);
    expect(archiveReads()).toBe(2);
  } finally {
    cleanup();
    act(() => owner.dispose());
  }
});

import { attestedOwner } from "../../features/agents/owner-attestation";
import {
  memberAuthority,
  memberChangeConfirmed,
  type MemberAuthority,
  type MemberChange,
} from "../../features/channel-members/administration-protocol";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import type { RelaySession } from "../../features/relay/session";
import { hasEventProof, type RelayEvent } from "../../features/relay/events";
import { channelIdentity } from "../../features/relay/channel-labels";
import { PublishRejected } from "../../features/relay/outbox";
import {
  DocConflict,
  DOC_KIND,
  DOC_LABEL,
  DOC_PAGE,
  PUBKEY,
  UUID,
  docAddress,
  docKey,
  independentDocStorage,
  docTag,
  docTemplate,
  parseDoc,
  readDoc,
  readDocHistory,
  saveDoc,
  validateDraft,
  type Doc,
  type DocAddress,
  type DocDraft,
  type DocPublish,
  type DocRead,
} from "./model";

type Cursor = { until: number; before_id: string };
export type DocsPage = {
  docs: Doc[];
  more: boolean;
  cursor?: Cursor | undefined;
};
type NewDoc = DocDraft & { id: string };
type CreatingAgent = {
  key: string;
  read: DocRead;
  publish: DocPublish;
};
export class DocCreationUnconfirmed extends Error {}

const documentLabel = (id: string) => `${DOC_LABEL}.${id}`;

/** Feature-owned orchestration; the session and host retain all signing/access authority. */
export function createDocsWorkspace(session: RelaySession) {
  const lifetime = new AbortController();
  // Unsaved work belongs to this identity/session, never a URL or relay record.
  const drafts = new Map<
    string,
    {
      base: Doc;
      title: string;
      markdown: string;
      restoreFrom?: Doc;
      awaitingReceipt?: true;
      settlement?: Promise<Doc>;
    }
  >();
  const signal = (caller?: AbortSignal) =>
    AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30_000),
      ...(caller ? [caller] : []),
    ]);
  const snapshot = async (
    filters: Parameters<DocRead>[0],
    caller?: AbortSignal,
    priority?: "background",
  ) => {
    const active = signal(caller);
    const options = { signal: active, ...(priority ? { priority } : {}) };
    active.throwIfAborted();
    if (!session.snapshotRead)
      throw new Error("Connect to your community to use working docs.");
    let events: readonly RelayEvent[];
    try {
      events = await session.snapshotRead(filters, options);
    } catch (error) {
      // Initial signed roster discovery can invalidate a concurrent finite read.
      // Retry that read once under the new access epoch; caller cancellation,
      // timeouts and terminal relay refusals never authorize a retry.
      if (
        active.aborted ||
        !(error instanceof DOMException) ||
        error.name !== "AbortError"
      )
        throw error;
      events = await session.snapshotRead(filters, options);
    }
    active.throwIfAborted();
    return events;
  };
  const read: DocRead = snapshot;
  const publish = async (
    template: Parameters<DocPublish>[0],
    caller?: AbortSignal,
    onDelivery?: () => void,
  ) => {
    const active = signal(caller);
    const writer = session.configArtifactWriter;
    if (!writer)
      throw new Error("Saving working docs is unavailable on this connection.");
    const event = await writer.sign(
      {
        ...template,
        tags: template.tags.map((tag) => [...tag]),
        created_at: Math.floor(Date.now() / 1000),
      },
      active,
    );
    active.throwIfAborted();
    onDelivery?.();
    await writer.publish(event, active);
    active.throwIfAborted();
    return event;
  };
  async function resolve(address: DocAddress, caller?: AbortSignal) {
    docAddress(address);
    const active = signal(caller);
    await session.channels.resolve?.([address.channel], {
      signal: active,
      consistency: "strong",
    });
    active.throwIfAborted();
  }
  async function sharing(channel: string, caller?: AbortSignal) {
    if (!session.relayAuthor || !session.viewer)
      throw new Error("Connect to read doc sharing.");
    const relayAuthor = session.relayAuthor;
    const events = await snapshot(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        authors: [relayAuthor],
        "#d": [channel],
        limit: 1,
        consistency: "strong" as const,
      })),
      caller,
    );
    const authority = memberAuthority(
      events,
      channel,
      session.viewer,
      relayAuthor,
    );
    const metadata = events.find(
      (event) =>
        event.kind === 39000 &&
        event.pubkey === relayAuthor &&
        docTag(event, "d") === channel,
    );
    if (!metadata) throw new Error("Doc sharing is unavailable.");
    const identity = channelIdentity(metadata);
    return {
      authority,
      metadata,
      labels: identity.labels,
      type: identity.type,
      private: metadata.tags.some(
        (tag) => tag.length === 1 && tag[0] === "private",
      ),
    };
  }
  const authority = async (
    channel: string,
    caller?: AbortSignal,
  ): Promise<MemberAuthority> => (await sharing(channel, caller)).authority;
  const independent = (
    address: DocAddress,
    state: Awaited<ReturnType<typeof sharing>>,
  ) => independentDocStorage(address, state.metadata);
  async function singleDoc(address: DocAddress, caller?: AbortSignal) {
    const heads = await read(
      [
        {
          kinds: [DOC_KIND],
          "#h": [address.channel],
          limit: 2,
          consistency: "strong",
        },
      ],
      caller,
    );
    const [head] = heads;
    if (heads.length !== 1 || !head || docTag(head, "d") !== address.id)
      throw new Error(
        "This storage contains other docs. Create a separate working copy before sharing this doc.",
      );
  }
  function generalAccess(address: DocAddress): ChannelDetailsCapability {
    const details = session.channelDetails;
    async function guard(channel: string, caller?: AbortSignal) {
      if (channel !== address.channel) throw new Error("Invalid doc channel.");
      await resolve(address, caller);
      if (!independent(address, await sharing(channel, caller)))
        throw new Error("This doc does not have independent sharing settings.");
      await singleDoc(address, caller);
    }
    return {
      available: details.available,
      subscribe: details.subscribe,
      snapshot: details.snapshot,
      async load(channel, caller) {
        await guard(channel, caller);
        return details.load(channel, caller);
      },
      async save(base, draft, caller, active) {
        if (
          draft.visibility !== "private" &&
          !(draft.visibility === "public" && draft.joinRole === "guest")
        )
          throw new Error("Choose private or community view-only access.");
        await guard(base.channelId, caller);
        return details.save(base, draft, caller, active);
      },
      async check(channel, caller) {
        await guard(channel, caller);
        return details.check(channel, caller);
      },
    };
  }
  async function verifyCreatingAgent(key: string, caller?: AbortSignal) {
    if (!PUBKEY.test(key)) throw new Error("Choose a valid creating agent.");
    session.agentChoices.ensure(true, true);
    if (
      !session.agentChoices.snapshot().complete ||
      session.agentChoices.snapshot().pending
    )
      await session.agentChoices.refresh(true);
    signal(caller).throwIfAborted();
    const choices = session.agentChoices.snapshot();
    if (!choices.complete || choices.pending)
      throw new Error(
        "Your agent list is incomplete. Refresh it before creating an agent doc.",
      );
    if (!choices.selectable.some((agent) => agent.pubkey === key))
      throw new Error("This creating agent is unavailable.");
    const [profile] = await snapshot(
      [{ kinds: [0], authors: [key], limit: 1, consistency: "strong" }],
      caller,
    );
    if (
      !profile ||
      !hasEventProof(profile) ||
      (await attestedOwner(profile)) !== session.viewer
    )
      throw new Error("This caller’s ownership could not be verified.");
  }
  async function setMember(
    address: DocAddress,
    key: string,
    access: "read" | "edit" | "admin" | "remove",
    caller?: AbortSignal,
    options: {
      expectedRole?: MemberChange["expectedRole"];
    } = {},
  ) {
    if (!PUBKEY.test(key)) throw new Error("Choose a valid public key.");
    await resolve(address, caller);
    const state = await sharing(address.channel, caller);
    if (!independent(address, state))
      throw new Error("This doc does not use independent doc sharing.");
    await singleDoc(address, caller);
    const roles = state.authority;
    if (
      !roles.canManage ||
      key === session.viewer ||
      roles.roles[key] === "owner"
    )
      throw new Error("You cannot change this person’s doc access.");
    const previous = roles.roles[key];
    if (
      options.expectedRole !== undefined &&
      (options.expectedRole === "absent"
        ? !!previous
        : previous !== options.expectedRole)
    )
      throw new Error(
        "This person’s access changed. Refresh access before retrying.",
      );
    const role =
      access === "read" ? "guest" : access === "admin" ? "admin" : "member";
    if (previous) {
      if (access === "remove" || previous !== role)
        await session.memberAdministration.run(address.channel, {
          pubkey: key,
          expectedRole: previous,
          role: access === "remove" ? "remove" : role,
        });
    } else if (access !== "remove") {
      if (!session.outbox?.supports(9000))
        throw new Error("Sharing is unavailable on this connection.");
      // A reader is admitted directly as guest, never briefly as an editor.
      const id = session.outbox.send({
        kind: 9000,
        content: "",
        tags: [
          ["h", address.channel],
          ["p", key],
          ["role", role],
        ],
      });
      await session.channelWrites.delivered(id);
      await session.channels.refreshRoster?.(address.channel, {
        signal: signal(caller),
        consistency: "strong",
      });
    }
    const confirmed = await authority(address.channel, caller);
    if (
      !memberChangeConfirmed(confirmed, session.viewer ?? "", {
        pubkey: key,
        expectedRole: previous ?? "absent",
        role: access === "remove" ? "remove" : role,
      })
    )
      throw new Error(
        "The sharing change could not be confirmed. Refresh access before retrying.",
      );
    return confirmed;
  }
  async function create(
    input: NewDoc,
    caller?: AbortSignal,
    agent?: CreatingAgent,
  ) {
    if (!session.configArtifactWriter)
      throw new Error(
        "This connection does not advertise support for working-doc revisions.",
      );
    validateDraft(input);
    if (!UUID.test(input.id))
      throw new Error("Use a new doc UUID and reuse it when retrying.");
    // Agent creation admits only its verified caller, never the owner’s inventory.
    if (agent) await verifyCreatingAgent(agent.key, caller);
    if (!session.viewer || !session.relayAuthor)
      throw new Error("Connect to create a doc.");
    const label = documentLabel(input.id);
    const found = await read(
      [
        {
          kinds: [39000],
          authors: [session.relayAuthor],
          "#P": [session.viewer],
          "#t": [label],
          limit: 2,
          consistency: "strong",
        },
      ],
      caller,
    );
    if (found.length > 1)
      throw new Error(
        "Multiple storage channels match this doc. Resolve them before creating another.",
      );
    let channel = found[0] ? docTag(found[0], "d") : undefined;
    if (found[0] && (!channel || !UUID.test(channel)))
      throw new Error("The doc’s storage identity is invalid.");
    if (
      found[0] &&
      (!found[0].tags.some((tag) => tag.length === 1 && tag[0] === "private") ||
        found[0].tags.find(([key]) => key === "t")?.[1] !== "system")
    )
      throw new Error(
        "The doc’s storage channel has unexpected access settings.",
      );
    if (!channel)
      channel = await session.channelCreation.create({
        name: `Doc ${input.id.slice(0, 8)}`,
        visibility: "private",
        system: true,
        labels: [DOC_LABEL, label],
      });
    const address = docAddress({ id: input.id, channel });
    await resolve(address, caller);
    const state = await sharing(channel, caller);
    if (
      !independent(address, state) ||
      state.authority.roles[session.viewer] !== "owner"
    )
      throw new Error(
        "The doc’s storage channel has unexpected access settings.",
      );
    const existing = await read(
      [
        {
          kinds: [DOC_KIND],
          "#h": [channel],
          "#d": [input.id],
          limit: 1,
          consistency: "strong",
        },
      ],
      caller,
    );
    if (existing[0]) {
      // Owner access can establish that storage is occupied. Only the caller's
      // read can supply content, including the current revision in a conflict.
      const doc = await readDoc(agent?.read ?? read, address, signal(caller));
      if (
        doc.deleted ||
        doc.title !== input.title.trim() ||
        doc.markdown !== input.markdown
      )
        throw new DocConflict(doc);
      return doc;
    }
    const otherDocuments = await read(
      [
        {
          kinds: [DOC_KIND],
          "#h": [channel],
          limit: 1,
          consistency: "strong",
        },
      ],
      caller,
    );
    if (otherDocuments.length)
      throw new Error(
        "This storage already contains another doc. Use a new doc ID.",
      );
    const template = docTemplate(address, input);
    if (agent) await session.memberAdditions.add(channel, agent.key);
    const active = signal(caller);
    active.throwIfAborted();
    let deliveryStarted = !!agent;
    try {
      const event = agent
        ? await agent.publish(template, active)
        : await publish(template, active, () => {
            deliveryStarted = true;
          });
      const current = await readDoc(agent?.read ?? read, address, active);
      if (current.revision !== event.id)
        throw new Error(
          "The doc has changed. Open its latest revision before editing.",
        );
      return current;
    } catch (error) {
      if (!deliveryStarted) throw error;
      const message = `Reuse doc ID ${input.id} to recover its storage and check the result. ${error instanceof Error ? error.message : ""}`;
      if (error instanceof PublishRejected) throw new Error(message);
      throw new DocCreationUnconfirmed(
        `Doc creation was not confirmed. ${message}`,
      );
    }
  }
  async function reconcile(
    addresses: readonly DocAddress[],
    caller: AbortSignal,
  ) {
    const active = signal(caller);
    await session.channels.resolve?.(
      [...new Set(addresses.map((address) => address.channel))],
      { signal: active, consistency: "strong", priority: "background" },
    );
    const readable = addresses.filter((address) =>
      session.channels.get?.(address.channel),
    );
    if (!readable.length) return [];
    const expected = new Set(readable.map(docKey));
    const events = await snapshot(
      [
        {
          kinds: [DOC_KIND],
          "#h": readable.map((address) => address.channel),
          "#d": readable.map((address) => address.id),
          limit: readable.length,
          consistency: "strong",
        },
      ],
      active,
      "background",
    );
    return events.flatMap((event) => {
      const head = parseDoc(event);
      return head && expected.has(docKey(head)) ? [head] : [];
    });
  }
  const list = (cursor?: Cursor, caller?: AbortSignal) =>
    readDocsPage(
      read,
      session.viewer ?? "",
      session.relayAuthor ?? "",
      cursor,
      caller,
    );
  return {
    session,
    read,
    publish,
    list,
    reconcile,
    create,
    resolve,
    authority,
    sharing,
    generalAccess,
    drafts,
    setMember,
    open: async (address: DocAddress, caller?: AbortSignal) => {
      await resolve(address, caller);
      return readDoc(read, address, caller);
    },
    save: (
      base: Doc,
      draft: DocDraft,
      op?: "update" | "delete" | "restore",
      caller?: AbortSignal,
    ) => saveDoc(read, publish, base, draft, op, caller),
    history: (address: DocAddress, offset = 0, caller?: AbortSignal) =>
      readDocHistory(read, address, offset, caller),
    dispose: () => {
      lifetime.abort();
      drafts.clear();
    },
  };
}
export type DocsWorkspace = ReturnType<typeof createDocsWorkspace>;

/** The same paged discovery for people and agents, always as its actual reader. */
export async function readDocsPage(
  read: DocRead,
  viewer: string,
  relayAuthor: string,
  cursor?: Cursor,
  caller?: AbortSignal,
): Promise<DocsPage> {
  if (!PUBKEY.test(viewer) || !PUBKEY.test(relayAuthor))
    throw new Error("Connect to read docs.");
  if (
    cursor !== undefined &&
    (!cursor ||
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join() !== "before_id,until" ||
      !Number.isSafeInteger(cursor.until) ||
      cursor.until < 0 ||
      typeof cursor.before_id !== "string" ||
      !PUBKEY.test(cursor.before_id))
  )
    throw new Error("Invalid doc-list cursor.");
  // One paged stream includes private memberships and community-readable docs.
  // Explicit system opt-in keeps ordinary channel discovery unchanged.
  const metadata = await read(
    [
      {
        kinds: [39000],
        authors: [relayAuthor],
        "#t": ["system"],
        limit: DOC_PAGE,
        ...cursor,
      },
    ],
    caller,
  );
  const ordered = [...metadata].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
  const last = ordered.at(-1);
  if (
    cursor &&
    last &&
    !(
      last.created_at < cursor.until ||
      (last.created_at === cursor.until && last.id > cursor.before_id)
    )
  )
    throw new Error("The doc list did not advance. Refresh to try again.");
  const addresses = metadata.flatMap((event) => {
    const channel = docTag(event, "d");
    const label = event.tags.find(
      ([key, value]) => key === "t" && value?.startsWith(`${DOC_LABEL}.`),
    );
    const id = label?.[1]?.slice(DOC_LABEL.length + 1);
    const address =
      channel && UUID.test(channel) && id && UUID.test(id)
        ? { id, channel }
        : undefined;
    return address && independentDocStorage(address, event) ? [address] : [];
  });
  const docs: Doc[] = [];
  if (addresses.length) {
    const events = await read(
      [
        {
          kinds: [DOC_KIND],
          "#h": addresses.map((item) => item.channel),
          "#d": addresses.map((item) => item.id),
          limit: DOC_PAGE,
          consistency: "strong",
        },
      ],
      caller,
    );
    for (const event of events) {
      const doc = parseDoc(event);
      if (
        doc &&
        addresses.some(
          (item) => item.id === doc.id && item.channel === doc.channel,
        )
      )
        docs.push(doc);
    }
  }
  return {
    docs,
    more: metadata.length === DOC_PAGE,
    ...(last ? { cursor: { until: last.created_at, before_id: last.id } } : {}),
  };
}

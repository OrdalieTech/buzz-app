import { viewerMember } from "../relay/membership";
import { agentUnavailable } from "../agents/choices";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type {
  LocalEvents,
  Outbox,
  OutgoingEvent,
  RecoveryJournal,
} from "../relay/outbox";
import type { RelayEvent } from "../relay/events";
import { migrationSource } from "../relay/migration";

const keyPattern = /^[0-9a-f]{64}$/;

/** Channel types whose members may add people. A system channel's members
 * are its readers, for example the agents a plugin shares its records with. */
const expandable = new Set(["stream", "forum", "system"]);

/** The relay remains authoritative; never offer role changes. DMs grow
 * through `canAddToDirectMessage` instead. */
export function canAddMembers(
  session: {
    viewer?: string | undefined;
    outbox?: { supports(kind: number): boolean } | undefined;
  },
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel &&
    channel.viewerRole !== "guest" &&
    !channel.archived &&
    expandable.has(channel.channelType ?? "") &&
    (viewerMember(channel, session.viewer) ||
      (channel.readOnly && !channel.private && channel.joinRole !== "guest"))
  );
}

/** A DM member may add people and agents to it; the relay decides whether a
 * person joins this DM or a new one (see `directMessages.add`). The relay's
 * moderation DM only carries its notices, so no one is added to it. */
export function canAddToDirectMessage(
  session: {
    viewer?: string | undefined;
    relayAuthor?: string | undefined;
    directMessages: { available: boolean };
  },
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.directMessages.available &&
    channel?.channelType === "dm" &&
    channel.viewerRole !== "guest" &&
    !channel.archived &&
    !channel.cached &&
    viewerMember(channel, session.viewer) &&
    (!session.relayAuthor ||
      (channel.members && !channel.members.includes(session.relayAuthor)))
  );
}

/** A session share adds only to this session. It never opens ordinary Members UI
 * or inherits parent-channel membership. */
export function canShareSoloChat(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel?.channelType === "solo" &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived &&
    viewerMember(channel, session.viewer)
  );
}

const channelOf = (session: RelaySession, channelId: string) =>
  session.channels.list().channels.find((item) => item.id === channelId) ??
  session.channels.get?.(channelId);

const knownAgent = (session: RelaySession, pubkey: string) =>
  session.agentChoices
    .snapshot()
    .identities.some((agent) => agent.pubkey === pubkey) ||
  !!session.profiles.snapshot().get(pubkey)?.isAgent;

/** An explicit Guest stays one; agents join as Bot. Solo sharing and
 * private-channel invitations grant participation explicitly, independently
 * of the admission default for public visitors. */
function additionRole(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  soloParticipant: boolean,
  intent?: MemberAdditionIntent,
) {
  const current = channelOf(session, channelId);
  return intent?.role
    ? intent.role
    : knownAgent(session, pubkey)
      ? "bot"
      : soloParticipant ||
          (current?.visibility === "private" &&
            (current.channelType === "stream" ||
              current.channelType === "forum"))
        ? "member"
        : undefined;
}

/** Reuse the outbox's durable operation on retry, including an unknown result. */
function waitForAddition(outbox: LocalEvents, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () =>
      finish(
        new Error(
          "Member addition interrupted. Reopen Members to check its status.",
        ),
      );
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Delivery alone is not membership confirmation. Always verify the roster next.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(
          new Error(
            item.error ?? "Addition is not confirmed. Retry to check again.",
          ),
        );
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}

const batchPrefix = "member-add:batch:";
const additionLifetimeSeconds = 15 * 60;
/** A batch clears once each person it names is confirmed or has a single receipt. */
export const isBatchAddition = (item: OutgoingEvent) =>
  !!item.recovery?.key.startsWith(batchPrefix);
const batchOrigin = (item: OutgoingEvent) =>
  item.recovery?.value === "1" ? item.event.id : item.recovery?.value;

export type MemberAdditionIntent = {
  id?: string;
  confirmed?: boolean;
  dismissed?: boolean;
  /** Adds the person as a guest, who can read but not post. */
  role?: "guest";
  /** Outbox recovery is not an explicit request to re-invite a removed member. */
  retry?: true;
  migration?: string | undefined;
  batchReceipt?: string | undefined;
};

/** Require the original batch's ownership before admitting a retry. */
async function withMigrationBatch(
  outbox: Outbox,
  journal: RecoveryJournal | undefined,
  id: string,
  migration: string | undefined,
  channelId: string,
  recipients: readonly string[],
  start: () => string | Promise<string>,
): Promise<string> {
  const batch =
    (await journal?.read())?.find((item) => item.event.id === id) ??
    outbox.snapshot().find((item) => item.event.id === id);
  if (
    !journal ||
    !batch?.recovery ||
    !isBatchAddition(batch) ||
    batch.acknowledged ||
    batch.event.kind !== 9000 ||
    migration === undefined ||
    migrationSource(batch.event.tags) !== migration ||
    !batch.event.tags.some(
      ([tag, value]) => tag === "h" && value === channelId,
    ) ||
    !recipients.every((key) =>
      batch.event.tags.some(([tag, value]) => tag === "p" && value === key),
    ) ||
    !outbox.withRecovery
  )
    throw new Error(
      "The original migration batch is unavailable. Refresh the Outbox before retrying.",
    );
  let operation = "";
  await outbox.withRecovery(id, batch.recovery, async () => {
    operation = await start();
    await journal.flush();
  });
  return operation;
}

function withMemberMigration<T>(
  outbox: Outbox | undefined,
  channelId: string,
  migration: string | undefined,
  run: (journal?: RecoveryJournal) => Promise<T>,
) {
  if (migration === undefined) return run();
  const lock = outbox?.withRecoveryJournal;
  if (!lock) throw new Error("Migration recovery is unavailable on this host.");
  return lock(`member-add:${channelId}`, run);
}

/** Explicit single-person intent. Membership truth and pending writes stay
 * session-owned. Whatever the outcome, settles the batches it may complete. */
export async function addChannelMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  intent: MemberAdditionIntent = {},
  receipts?: LocalEvents,
  soloParticipant = false,
) {
  try {
    await withMemberMigration(
      session.outbox,
      channelId,
      intent.migration,
      (journal) =>
        addOneMember(
          session,
          channelId,
          pubkey,
          signal,
          intent,
          receipts,
          soloParticipant,
          journal,
        ),
    );
  } finally {
    await settleBatchAdditions(session, channelId);
  }
}

async function addOneMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  intent: MemberAdditionIntent = {},
  receipts: LocalEvents | undefined = session.outbox,
  soloParticipant = false,
  sharedJournal?: RecoveryJournal,
): Promise<void> {
  if (!keyPattern.test(pubkey))
    throw new Error("Choose a valid person or agent.");
  const channel = () => channelOf(session, channelId);
  const checkAccess = () => {
    signal.throwIfAborted();
    if (
      !(soloParticipant
        ? canShareSoloChat(session, channel())
        : canAddMembers(session, channel()))
    )
      throw new Error(
        "This channel cannot add members right now. Refresh and try again.",
      );
    if (agentUnavailable(session, pubkey))
      throw new Error(
        "Archived identities and agents being deleted cannot be added. Choose someone else.",
      );
  };
  checkAccess();
  const outbox = session.outbox;
  if (!outbox) throw new Error("Member additions are unavailable.");
  await outbox.ready();
  checkAccess();
  // This existing session operation verifies the connected relay's signed roster.
  await session.channelWrites.refreshMembership(channelId);
  checkAccess();
  const journal = receipts ?? outbox;
  // Only a roster-confirmed prior addition may be superseded by explicit Add.
  const fresh =
    intent.dismissed ||
    (intent.confirmed && !channel()?.members?.includes(pubkey));
  const matchesTarget = (event: Pick<RelayEvent, "kind" | "tags">) =>
    event.kind === 9000 &&
    event.tags.some(([tag, value]) => tag === "h" && value === channelId) &&
    event.tags.some(([tag, value]) => tag === "p" && value === pubkey);
  const noRole = (event: Pick<RelayEvent, "tags">) =>
    !event.tags.some(([tag]) => tag === "role");
  if (sharedJournal && !fresh) {
    const shared = (await sharedJournal.read()).find(
      (item) =>
        !item.acknowledged &&
        !isBatchAddition(item) &&
        matchesTarget(item.event),
    );
    if (shared && (!intent.id || shared.event.id === intent.id))
      sharedJournal.adopt(shared);
  }
  const saved = journal.snapshot();
  const pending = fresh
    ? undefined
    : (saved.find((item) =>
        intent.id
          ? item.event.id === intent.id
          : !item.acknowledged &&
            !isBatchAddition(item) &&
            matchesTarget(item.event),
      ) ??
      // Keep a resolved legacy Guest outcome actionable after restart.
      (soloParticipant && channel()?.members?.includes(pubkey)
        ? saved.find(
            (item) =>
              item.acknowledged &&
              !isBatchAddition(item) &&
              matchesTarget(item.event) &&
              noRole(item.event),
          )
        : undefined));
  // A saved addition finishes only with the role this one asks for.
  const savedRole = pending?.event.tags.find(([tag]) => tag === "role")?.[1];
  const sameRole = intent.role
    ? savedRole === intent.role
    : savedRole === undefined || savedRole === "bot" || savedRole === "member";

  const recovery = { key: `member-add:${channelId}:${pubkey}`, value: "1" };
  // A saved share may finish its exact Bot grant; it cannot authorize a new one.
  const recoveringSoloAgent =
    pending &&
    !pending.acknowledged &&
    !pending.guarded &&
    pending.recovery?.key === recovery.key &&
    pending.event.tags.some(
      ([tag, value]) => tag === "role" && value === "bot",
    );
  const check = () => {
    checkAccess();
    if (soloParticipant && !recoveringSoloAgent && knownAgent(session, pubkey))
      throw new Error(
        "Add agents by tagging them in the chat composer instead.",
      );
  };
  check();
  // A completed or missing receipt is not permission for Retry to create a grant.
  if (intent.retry && !pending) return;
  if (
    pending &&
    migrationSource(pending.event.tags) !== intent.migration &&
    !channel()?.members?.includes(pubkey)
  )
    throw new Error(
      "This member has an addition with a different migration source in Outbox. Retry it there or remove it once it shows Not sent.",
    );
  const confirmAddition = async (id: string) => {
    intent.id = id;
    intent.dismissed = false;
    intent.confirmed = false;
    await waitForAddition(journal, id, signal);
    check();
    await session.channelWrites.refreshMembership(channelId);
    check();
    if (!channel()?.members?.includes(pubkey))
      throw new Error(
        "Addition is not confirmed in the member list yet. Retry to check again.",
      );
    await outbox.acknowledge(id);
    check();
    intent.confirmed = true;
  };
  if (pending?.guarded && !channel()?.members?.includes(pubkey))
    throw new Error(
      "Retry this invitation from the agent’s profile so its eligibility can be checked.",
    );
  const expired =
    pending?.delivery === "failed" &&
    Date.now() / 1000 - pending.event.created_at >= additionLifetimeSeconds;
  // The relay refuses an expired event, so an explicit Add replaces it.
  // Unapplied legacy invitations are retired with their own replacement below.
  if (
    expired &&
    !intent.retry &&
    !pending.acknowledged &&
    !(soloParticipant && noRole(pending.event))
  ) {
    await outbox.dismiss(pending.event.id);
    check();
    if (journal.snapshot().some((item) => item.event.id === pending.event.id))
      throw new Error(
        "This addition is still in progress. Try again when it finishes.",
      );
    intent.dismissed = true;
    return addOneMember(
      session,
      channelId,
      pubkey,
      signal,
      intent,
      receipts,
      soloParticipant,
      sharedJournal,
    );
  }
  if (soloParticipant && pending && noRole(pending.event))
    intent.id = pending.event.id;
  if (pending && !sameRole && !channel()?.members?.includes(pubkey))
    throw new Error(
      "This member is already being added with another role. Wait for it to finish, or add them with that role to retry it, then try again.",
    );

  if (pending && !pending.acknowledged)
    await outbox.recover(pending.event.id, recovery);
  check();
  if (soloParticipant && pending && noRole(pending.event)) {
    if (!channel()?.members?.includes(pubkey)) {
      let replacement: string | undefined;
      let recorded = false;
      await outbox.acknowledge(
        pending.event.id,
        async (event) => {
          check();
          recorded = await session.channelWrites.additionRecorded(
            event,
            signal,
          );
          // Finish the fresh membership check while the original is recoverable.
          await session.channelWrites.refreshMembership(channelId);
          check();
          return recorded ? "recorded" : undefined;
        },
        {
          input: () => {
            check();
            if (
              channel()?.members?.includes(pubkey) ||
              (intent.retry && recorded)
            )
              return undefined;
            return invitation();
          },
          queued: (id) => {
            replacement = id;
          },
        },
      );
      if (replacement) return confirmAddition(replacement);
      check();
      intent.confirmed = true;
      // Retiring a recorded command must not fall through to a new grant.
      if (intent.retry && recorded && !channel()?.members?.includes(pubkey))
        return;
      // A joined target still needs role reconciliation; never overwrite a Guest.
      return addOneMember(
        session,
        channelId,
        pubkey,
        signal,
        intent,
        receipts,
        soloParticipant,
      );
    }
    await session.memberAdministration.refresh(channelId);
    check();
    const verified = session.memberAdministration.snapshot(channelId);
    const role = verified.authority.roles[pubkey];
    if (
      verified.status !== "ready" ||
      verified.operation?.status === "pending" ||
      !role ||
      role === "unknown"
    )
      throw new Error(
        "Current access could not be confirmed. Refresh members and roles before trying again.",
      );
    // Membership resolves the original command, even when its grant was Guest.
    // Do not promote a newer role or replay the old command after removal.
    if (role === "guest") {
      await outbox.acknowledge(pending.event.id);
      check();
      intent.confirmed = true;
      throw new Error(
        "This earlier invitation granted view-only access. To grant participation, remove them in People and invite them again.",
      );
    }
  }
  if (channel()?.members?.includes(pubkey)) {
    if (!intent.id && pending) intent.id = pending.event.id;
    if (pending) await outbox.acknowledge(pending.event.id);
    check();
    intent.confirmed = true;
    return;
  }
  if (!fresh && intent.id && !pending)
    throw new Error(
      "The original addition receipt is unavailable. Refresh membership before trying again.",
    );
  if (expired)
    throw new Error("This addition expired. Add them again to send a new one.");

  const send = () => {
    check();
    const id = pending?.event.id ?? outbox.send(invitation(), recovery);
    if (pending?.delivery === "failed" || pending?.delivery === "unknown")
      outbox.retry(id);
    return id;
  };
  const resume = async () => {
    if (!sharedJournal || !pending || pending.acknowledged) return send();
    const withRecovery = outbox.withRecovery;
    if (!withRecovery)
      throw new Error("Migration recovery is unavailable on this host.");
    const id = pending.event.id;
    await withRecovery(id, recovery, () => {
      if (channel()?.members?.includes(pubkey))
        throw new Error("Membership changed during retry. Try again.");
      send();
      return waitForAddition(journal, id, signal);
    });
    return id;
  };
  const id =
    intent.batchReceipt === undefined
      ? await resume()
      : await withMigrationBatch(
          outbox,
          sharedJournal,
          intent.batchReceipt,
          intent.migration,
          channelId,
          [pubkey],
          () => {
            if (channel()?.members?.includes(pubkey))
              throw new Error("Membership changed during retry. Try again.");
            return resume();
          },
        );
  return confirmAddition(id);

  function invitation() {
    const role = additionRole(
      session,
      channelId,
      pubkey,
      soloParticipant,
      intent,
    );
    return {
      kind: 9000,
      content: "",
      tags: [
        ["h", channelId],
        ["p", pubkey],
        ...(role ? [["role", role]] : []),
        ...(intent.migration ? [["migration", intent.migration]] : []),
      ],
    };
  }
}

/** A batch is the only durable record of the people it names until each is
 * in the roster or has their own addition pending, so only then is it
 * acknowledged. Batches still sending are left to their own sender. */
export async function settleBatchAdditions(
  session: RelaySession,
  channelId: string,
) {
  const outbox = session.outbox;
  if (!outbox) return;
  const items = outbox
    .snapshot()
    .filter(
      (item) =>
        !item.acknowledged &&
        item.event.kind === 9000 &&
        item.event.tags.some(
          ([tag, value]) => tag === "h" && value === channelId,
        ),
    );
  const named = (item: OutgoingEvent) =>
    item.event.tags.flatMap(([tag, value]) =>
      tag === "p" && value ? [value] : [],
    );
  const members = new Set(channelOf(session, channelId)?.members);
  const singles = new Map<string | undefined, Set<string>>();
  for (const item of items) {
    if (isBatchAddition(item)) continue;
    const source = migrationSource(item.event.tags);
    const covered = singles.get(source) ?? new Set<string>();
    for (const key of named(item)) covered.add(key);
    singles.set(source, covered);
  }
  for (const item of items) {
    if (!isBatchAddition(item) || item.delivery === "sending") continue;
    const covered = singles.get(migrationSource(item.event.tags));
    if (named(item).every((key) => members.has(key) || covered?.has(key)))
      await outbox.acknowledge(item.event.id).catch(() => {});
  }
}

/** Most people one kind:9000 may name; see the relay's put-user handler. */
const batchLimit = 100;

/**
 * Adds people missing from a channel with one kind:9000 per role and at most
 * 100 people, then reads the roster once. Returns everyone it shows, including
 * people already there. A relay without batch support adds only the first
 * person each event names. Ordinary additions are best effort. For a
 * migration, a failed send or roster read stops the batch without fallback.
 * Everyone not returned is left to `addChannelMember`, which also says
 * why they failed, as is anyone with an earlier single addition pending, so a
 * stale role is never resent. A labeled batch can reuse an unresolved receipt
 * for the same role and recipients after a fresh roster check. A batch stays
 * in Outbox until everyone it names is settled.
 */
export async function addChannelMembersAtOnce(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: ReadonlyMap<string, MemberAdditionIntent>,
  signal: AbortSignal,
  soloParticipant = false,
  /** Receipts the single addition reads, including resolved ones. */
  receipts?: LocalEvents,
): Promise<ReadonlySet<string>> {
  const { migration } = intents.values().next().value ?? {};
  return withMemberMigration(session.outbox, channelId, migration, (journal) =>
    addMemberBatch(
      session,
      channelId,
      people,
      intents,
      signal,
      soloParticipant,
      receipts,
      journal,
    ),
  );
}

async function addMemberBatch(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: ReadonlyMap<string, MemberAdditionIntent>,
  signal: AbortSignal,
  soloParticipant: boolean,
  receipts: LocalEvents | undefined,
  sharedJournal?: RecoveryJournal,
): Promise<ReadonlySet<string>> {
  const confirmed = new Set<string>();
  const outbox = session.outbox;
  if (people.length < 2 || !outbox) return confirmed;
  const { migration, batchReceipt } = intents.values().next().value ?? {};
  const allowed = () =>
    soloParticipant
      ? canShareSoloChat(session, channelOf(session, channelId))
      : canAddMembers(session, channelOf(session, channelId));
  const attempt = async <T>(work: () => T | Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      signal.throwIfAborted();
      if (migration !== undefined) throw error;
      return undefined;
    }
  };
  // Restored receipts count, so read them only once the outbox has loaded.
  const loaded = await attempt(async () => {
    await outbox.ready();
    return true;
  });
  if (!loaded) return confirmed;
  const singles = (
    sharedJournal ? await sharedJournal.read() : (receipts ?? outbox).snapshot()
  ).filter(
    (item) =>
      !isBatchAddition(item) &&
      item.event.kind === 9000 &&
      item.event.tags.some(
        ([tag, value]) => tag === "h" && value === channelId,
      ),
  );
  const named = (items: readonly OutgoingEvent[]) =>
    new Set(
      items.flatMap(({ event }) =>
        event.tags.flatMap(([tag, value]) => (tag === "p" ? [value] : [])),
      ),
    );
  const pending = named(singles.filter((item) => !item.acknowledged));
  // A Solo chat's resolved no-role invitation may have granted Guest, which
  // only the single addition reconciles and reports.
  const legacy = soloParticipant
    ? named(
        singles.filter(
          (item) =>
            item.acknowledged &&
            !item.event.tags.some(([tag]) => tag === "role"),
        ),
      )
    : new Set<string>();
  // Anyone with a single addition pending, or whom one would refuse, stays
  // with it: it alone may resume that write, and it reports why. Retry only
  // finishes an existing receipt, so it never joins a batch.
  const eligible = people.filter(
    (key) =>
      keyPattern.test(key) &&
      !intents.get(key)?.id &&
      !intents.get(key)?.retry &&
      !pending.has(key) &&
      !legacy.has(key) &&
      !agentUnavailable(session, key) &&
      // A Solo chat's agents keep their own receipts, so a recovering share
      // can finish its exact Bot grant.
      !(soloParticipant && knownAgent(session, key)),
  );
  if (eligible.length < 2) return confirmed;
  const before = allowed()
    ? await attempt(() => session.channelWrites.refreshMembership(channelId))
    : undefined;
  signal.throwIfAborted();
  if (!before || !allowed()) return confirmed;
  const groups = new Map<string | undefined, string[]>();
  for (const key of eligible)
    if (!before.members?.includes(key)) {
      const role = additionRole(
        session,
        channelId,
        key,
        soloParticipant,
        intents.get(key),
      );
      groups.set(role, [...(groups.get(role) ?? []), key]);
    }
  let sent = false;
  try {
    let roster: ChannelSummary | undefined = before;
    let dispatched = false;
    // One missing person gains nothing from a batch; the single addition sends it.
    if ([...groups.values()].flat().length > 1)
      for (const [role, keys] of groups)
        for (let start = 0; start < keys.length; start += batchLimit) {
          // Each later write reads the roster again, so it never names someone
          // admitted meanwhile, whose role an explicit one would overwrite.
          if (dispatched)
            roster = await attempt(() =>
              session.channelWrites.refreshMembership(channelId),
            );
          if (!roster || !allowed()) break;
          const recipients = keys.slice(start, start + batchLimit).filter(
            (key) =>
              !roster?.members?.includes(key) &&
              // Archives may refresh during any read, as the single addition rechecks.
              !agentUnavailable(session, key),
          );
          if (!recipients.length) continue;
          dispatched = true;
          const checkRecipients = () => {
            signal.throwIfAborted();
            const members = channelOf(session, channelId)?.members;
            if (
              !allowed() ||
              recipients.some(
                (key) =>
                  agentUnavailable(session, key) || members?.includes(key),
              )
            )
              throw new Error(
                "Membership changed before the addition. Try again.",
              );
          };
          const id = await attempt(async () => {
            let origin: string | undefined;
            if (sharedJournal) {
              const records = await sharedJournal.read();
              const original =
                batchReceipt === undefined
                  ? undefined
                  : (records.find((item) => item.event.id === batchReceipt) ??
                    outbox
                      .snapshot()
                      .find((item) => item.event.id === batchReceipt));
              if (
                batchReceipt !== undefined &&
                (!original ||
                  !isBatchAddition(original) ||
                  original.acknowledged)
              )
                throw new Error(
                  "The original migration batch is unavailable. Refresh the Outbox before retrying.",
                );
              origin = original && batchOrigin(original);
              const saved = records.find((item) => {
                if (
                  item.event.kind !== 9000 ||
                  (origin !== undefined && batchOrigin(item) !== origin) ||
                  !isBatchAddition(item) ||
                  item.acknowledged ||
                  !item.signed ||
                  !["failed", "unknown", "sending"].includes(item.delivery) ||
                  Date.now() / 1000 - item.event.created_at >=
                    additionLifetimeSeconds
                )
                  return false;
                const { tags } = item.event;
                const people = new Set(
                  tags.flatMap(([tag, key]) =>
                    tag === "p" && key ? [key] : [],
                  ),
                );
                return (
                  migrationSource(tags) === migration &&
                  tags.some(
                    ([tag, value]) => tag === "h" && value === channelId,
                  ) &&
                  tags.find(([tag]) => tag === "role")?.[1] === role &&
                  people.size === recipients.length &&
                  recipients.every((key) => people.has(key))
                );
              });
              if (saved?.recovery) {
                const id = saved.event.id;
                const { withRecovery } = outbox;
                const { recovery } = saved;
                if (!withRecovery)
                  throw new Error(
                    "The original migration batch cannot be retried on this host.",
                  );
                // The older receipt authorizes the selection. The smaller
                // batch owns its own signed delivery and has a separate lock.
                const target =
                  batchReceipt !== undefined && id !== batchReceipt
                    ? await withMigrationBatch(
                        outbox,
                        sharedJournal,
                        batchReceipt,
                        migration,
                        channelId,
                        recipients,
                        () => id,
                      )
                    : id;
                await withRecovery(target, recovery, () => {
                  checkRecipients();
                  sharedJournal.adopt(saved);
                  outbox.retry(target);
                  return waitForAddition(outbox, target, signal);
                });
                return target;
              }
            }
            const send = () => {
              if (sharedJournal) checkRecipients();
              return outbox.send(
                {
                  kind: 9000,
                  content: "",
                  tags: [
                    ["h", channelId],
                    ...recipients.map((key) => ["p", key]),
                    ...(role ? [["role", role]] : []),
                    ...(migration ? [["migration", migration]] : []),
                  ],
                },
                {
                  key: `${batchPrefix}${crypto.randomUUID()}`,
                  value: origin ?? "1",
                },
              );
            };
            return batchReceipt === undefined
              ? send()
              : withMigrationBatch(
                  outbox,
                  sharedJournal,
                  batchReceipt,
                  migration,
                  channelId,
                  recipients,
                  send,
                );
          });
          if (!id) continue;
          sent = true;
          // For ordinary additions, a refusal or unknown result leaves the roster to decide.
          await attempt(() => waitForAddition(outbox, id, signal));
        }
    const after = sent
      ? await attempt(() => session.channelWrites.refreshMembership(channelId))
      : before;
    for (const key of eligible)
      if (after?.members?.includes(key)) confirmed.add(key);
    return confirmed;
  } finally {
    await settleBatchAdditions(session, channelId);
  }
}

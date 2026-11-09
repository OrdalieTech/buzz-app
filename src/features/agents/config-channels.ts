// Agent and team config channels (NIP-AP "Config channels"): the relay
// support check, labels, and the only calls this app makes into the NIP-CL
// system-channel API.
import {
  administerMember,
  type MemberResult,
} from "../channel-members/administration";
import type {
  MemberChange,
  MemberRole,
} from "../channel-members/administration-protocol";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  type SnapshotRead,
  teamLabel,
  uuidv5,
} from "./agent-config-artifacts";
import { attestedOwner } from "./owner-attestation";

export type ConfigFamily = "agent-config" | "team-config";

/** What the relay's NIP-11 document lets config use, or why it can't. */
export type ConfigSupport =
  | Readonly<{ supported: true; maxEventBytes: number }>
  | Readonly<{ supported: false; reason: string }>;

/** `["EVENT",` + `]`: the frame around a signed event. */
const FRAME_WRAPPER_BYTES = 16;

/** NIP-AP "Relay support": NIP-CL system channels and labels (`nip-cl`) and
 * NIP-AR artifacts (`nip-ar` with its `artifacts` descriptor), each as its own
 * spec advertises it. The writer also keeps every signed event within the
 * relay's advertised frame limit. */
export function configSupport(info: unknown): ConfigSupport {
  const doc = (info && typeof info === "object" ? info : {}) as Record<
    string,
    unknown
  >;
  const extensions = Array.isArray(doc.supported_extensions)
    ? doc.supported_extensions
    : [];
  if (!extensions.includes("nip-cl"))
    return { supported: false, reason: "no NIP-CL system channels" };
  const artifacts = doc.artifacts as Record<string, unknown> | undefined;
  if (
    !extensions.includes("nip-ar") ||
    artifacts?.version !== 1 ||
    artifacts.revision_kind !== 45010
  )
    return { supported: false, reason: "no NIP-AR artifacts" };
  const frame = (doc.limitation as Record<string, unknown> | undefined)
    ?.max_message_length;
  const advertised =
    typeof frame === "number" && Number.isSafeInteger(frame) && frame > 0
      ? frame - FRAME_WRAPPER_BYTES
      : ARTIFACT_MAX_EVENT_BYTES;
  return {
    supported: true,
    maxEventBytes: Math.min(ARTIFACT_MAX_EVENT_BYTES, advertised),
  };
}

/** The subject label of an agent's or team's config channel. */
export const agentSubject = (pubkey: string) => {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Invalid agent pubkey");
  return pubkey;
};
export const teamSubject = (team: string) => teamLabel(team);

/** UUIDv5(RFC 4122 URL namespace, "https://buzz.block.xyz/ns/team-import/v1"). */
export const BUZZ_TEAM_IMPORT_NS = "e73a27cc-feca-5161-82dd-620356b374a9";

/** The deterministic team id for an imported old Buzz team or a migrated
 * local team (plan §6.3): every device and every rerun computes the same id,
 * so concurrent imports converge on one config channel. */
export function importedTeamId(
  input: Readonly<{
    owner: string;
    community: string;
    source: "old-buzz-team" | "local-team";
    sourceId: string;
  }>,
) {
  return uuidv5(
    BUZZ_TEAM_IMPORT_NS,
    `v1\n${input.owner.toLowerCase()}\n${input.community.toLowerCase()}\n${input.source}\n${input.sourceId}`,
  );
}

export type ConfigChannel = Readonly<{
  id: string;
  archived: boolean;
  members?: readonly string[] | undefined;
}>;

/** A verified config channel of `family` for `subject`, made by `owner`. */
const isConfig = (
  channel: ChannelSummary,
  owner: string,
  family: ConfigFamily,
  subject: string,
) =>
  channel.channelType === "system" &&
  channel.creator === owner &&
  !!channel.labels?.includes(family) &&
  !!channel.labels.includes(subject);

export type { MemberResult };

export function createConfigChannels(
  session: RelaySession,
  owner: string,
  relay: Readonly<{ read: SnapshotRead; relayAuthor: string }>,
) {
  /** The selected config channel, archived ones included, or undefined when a
   * complete strong lookup found none. Throws when it can't tell. The family
   * label never joins the subject's `#t` filter (values in one filter OR). */
  async function find(
    family: ConfigFamily,
    subject: string,
    signal?: AbortSignal,
  ): Promise<ConfigChannel | undefined> {
    const findLabeled = session.channels.findLabeled;
    if (!findLabeled) throw new Error("Config channels are unavailable");
    const found = await findLabeled(
      { creator: owner, label: subject },
      { consistency: "strong", ...(signal ? { signal } : {}) },
    );
    // Oldest first already (NIP-CL "Choosing one channel"); others are never
    // archived or deleted for not being selected.
    const selected = found.find((channel) =>
      isConfig(channel, owner, family, subject),
    );
    return selected && view(selected);
  }

  /** The owner's team config channels, archived ones included: the selected
   * (oldest) one per subject label, with that label. */
  async function teams(signal?: AbortSignal) {
    const findLabeled = session.channels.findLabeled;
    if (!findLabeled) throw new Error("Config channels are unavailable");
    const found = await findLabeled(
      { creator: owner, label: "team-config" },
      { consistency: "strong", ...(signal ? { signal } : {}) },
    );
    const selected = new Map<string, ConfigChannel & { label: string }>();
    for (const channel of found) {
      // The family label also starts with "team-"; the subject is the other.
      const label = channel.labels?.find(
        (l) => l !== "team-config" && l.startsWith("team-"),
      );
      if (
        label &&
        !selected.has(label) &&
        isConfig(channel, owner, "team-config", label)
      )
        selected.set(label, { ...view(channel), label });
    }
    return [...selected.values()];
  }

  /** Find, and create only when a complete lookup found none. Concurrent
   * creators each make one; every client then selects the oldest. */
  async function ensure(
    family: ConfigFamily,
    subject: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<ConfigChannel> {
    const existing = await find(family, subject, signal);
    if (existing) return existing;
    await session.channelCreation.create({
      name,
      visibility: "private",
      labels: [family, subject],
      system: true,
    });
    const selected = await find(family, subject, signal);
    if (!selected) throw new Error("The new config channel isn't readable yet");
    return selected;
  }

  const archive = (channel: string, signal?: AbortSignal) => {
    if (!session.channelLifecycle.available)
      throw new Error("Channel archive is unavailable");
    return session.channelLifecycle.run("archive", channel, signal);
  };

  /** One member change through session administration, decided from a fresh
   * roster read: `decide` gets the key's verified role and returns the change,
   * or nothing when the roster already shows the result. */
  async function administer(
    channel: string,
    pubkey: string,
    decide: (
      role: MemberRole | undefined,
    ) => Omit<MemberChange, "pubkey"> | undefined,
  ): Promise<MemberResult> {
    return administerMember(
      session.memberAdministration,
      channel,
      pubkey,
      decide,
    );
  }

  async function owns(pubkey: string, signal?: AbortSignal) {
    const [profile, ...extra] = await relay.read(
      [{ kinds: [0], authors: [pubkey], limit: 1, consistency: "strong" }],
      { signal },
    );
    if (extra.length || profile?.kind !== 0 || profile.pubkey !== pubkey)
      return false;
    return (await attestedOwner(profile)) === owner;
  }

  return {
    find,
    teams,
    /** Whether `pubkey`'s newest profile carries this owner's NIP-OA proof. */
    owns,
    ensure,
    archive,
    /** Whether the relay's strong, relay-signed metadata shows the channel
     * archived. Anything but exactly one such answer throws; cached metadata
     * never stands in for it. */
    async archived(channel: string, signal?: AbortSignal) {
      const events = await relay.read(
        [
          {
            kinds: [39000],
            authors: [relay.relayAuthor],
            "#d": [channel],
            limit: 1,
            consistency: "strong",
          },
        ],
        { signal },
      );
      const [metadata] = events;
      if (
        events.length !== 1 ||
        metadata?.kind !== 39000 ||
        metadata.pubkey !== relay.relayAuthor ||
        !metadata.tags.some(([key, value]) => key === "d" && value === channel)
      )
        throw new Error("Config channel metadata is unavailable");
      return metadata.tags.some(
        ([key, value]) => key === "archived" && value === "true",
      );
    },
    /** Adds `pubkey` as a member of a system config channel it isn't in.
     * Only an agent whose newest profile carries one NIP-OA `auth` tag signed
     * by this owner is added; a local row is no proof of ownership. */
    async addMember(
      channel: string,
      pubkey: string,
      signal?: AbortSignal,
    ): Promise<MemberResult> {
      if (!(await owns(pubkey, signal)))
        return { status: "failed", error: "Not an agent you own" };
      return administer(channel, pubkey, (role) =>
        role ? undefined : { expectedRole: "none", role: "member" },
      );
    },
    /** Removes `pubkey` with whatever role a fresh roster read verifies. */
    removeMember: (channel: string, pubkey: string) =>
      administer(channel, pubkey, (role) =>
        role ? { expectedRole: role, role: "remove" } : undefined,
      ),
  };
}
export type ConfigChannels = ReturnType<typeof createConfigChannels>;

const view = (channel: ChannelSummary): ConfigChannel => ({
  id: channel.id,
  archived: !!channel.archived,
  members: channel.members,
});

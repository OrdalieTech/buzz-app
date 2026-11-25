import type { EventData, ReadFilter } from "../../features/relay/events";

export const DOC_KIND = 45010;
export const DOC_TYPE = "buzz.doc";
export const DOC_LABEL = "buzz.docs";
export const DOC_PAGE = 100;
export const MAX_DOC_BYTES = 32_768;
export const UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const PUBKEY = /^[0-9a-f]{64}$/;
const envelope = new Set([
  "ar",
  "d",
  "h",
  "type",
  "title",
  "op",
  "root",
  "prev",
  "doc",
  "auth",
  "ms",
]);
const bytes = (text: string) => new TextEncoder().encode(text).length;

export type DocEvent = Pick<
  EventData,
  "id" | "pubkey" | "created_at" | "kind" | "content"
> & {
  readonly tags: readonly (readonly string[])[];
};
export type DocAddress = Readonly<{ id: string; channel: string }>;
export type Doc = DocAddress &
  Readonly<{
    revision: string;
    title: string;
    markdown: string;
    deleted: boolean;
    editable: boolean;
    event: DocEvent;
  }>;
export type DocDraft = Readonly<{
  title: string;
  markdown: string;
  restoreFrom?: Doc;
}>;
export type DocTemplate = Readonly<{
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;
export type DocRead = (
  filters: readonly ReadFilter[],
  signal?: AbortSignal,
) => Promise<readonly DocEvent[]>;
export type DocPublish = (
  template: DocTemplate,
  signal?: AbortSignal,
) => Promise<DocEvent>;

/** Singleton envelope tags are exact: malformed records never become editable. */
export function docTag(event: DocEvent, name: string) {
  const values = event.tags.filter(([key]) => key === name);
  return values.length === 1 && values[0]?.length === 2
    ? values[0][1]
    : undefined;
}
export function docAddress(value: unknown): DocAddress {
  const address = value as Partial<DocAddress> | null;
  if (
    !address ||
    typeof address.id !== "string" ||
    !UUID.test(address.id) ||
    typeof address.channel !== "string" ||
    !UUID.test(address.channel)
  )
    throw new Error("Invalid doc address.");
  return { id: address.id, channel: address.channel };
}
/** Storage convention only; callers establish signed membership independently. */
export function independentDocStorage(
  address: DocAddress,
  metadata: DocEvent | undefined,
) {
  if (metadata?.kind !== 39000 || docTag(metadata, "d") !== address.channel)
    return false;
  const labels = metadata.tags
    .filter(([key]) => key === "t")
    .map(([, value]) => value);
  const visibility = metadata.tags.filter(
    ([key]) => key === "public" || key === "private",
  );
  const admissions = metadata.tags.filter(([key]) => key === "join_role");
  return (
    labels[0] === "system" &&
    visibility.length === 1 &&
    visibility[0]?.length === 1 &&
    (visibility[0]?.[0] === "private" ||
      (visibility[0]?.[0] === "public" &&
        admissions.length === 1 &&
        admissions[0]?.length === 2 &&
        admissions[0]?.[1] === "guest")) &&
    labels.includes(DOC_LABEL) &&
    labels.includes(`${DOC_LABEL}.${address.id}`) &&
    labels.filter((label) => label?.startsWith(`${DOC_LABEL}.`)).length === 1
  );
}
export function parseDoc(event: DocEvent): Doc | undefined {
  const id = docTag(event, "d"),
    channel = docTag(event, "h");
  if (
    event.kind !== DOC_KIND ||
    docTag(event, "ar") !== "1" ||
    docTag(event, "type") !== DOC_TYPE ||
    !id ||
    !UUID.test(id) ||
    !channel ||
    !UUID.test(channel)
  )
    return;
  const op = docTag(event, "op");
  if (!["create", "update", "move", "delete", "restore"].includes(op ?? ""))
    return;
  if (
    (op !== "create" && !PUBKEY.test(docTag(event, "prev") ?? "")) ||
    (event.tags.some(([key]) => key === "root") &&
      !PUBKEY.test(docTag(event, "root") ?? ""))
  )
    return;
  const deleted = op === "delete";
  const title = docTag(event, "title");
  if (
    (!deleted && (!title?.trim() || bytes(title) > 512)) ||
    (deleted && event.content !== "")
  )
    return;
  return {
    id,
    channel,
    revision: event.id,
    title: deleted ? "Deleted doc" : (title ?? ""),
    markdown: event.content,
    deleted,
    editable:
      deleted ||
      (docTag(event, "doc") === "1" && bytes(event.content) <= MAX_DOC_BYTES),
    event,
  };
}
export function validateDraft(draft: DocDraft) {
  if (!draft.title.trim() || bytes(draft.title) > 512)
    throw new Error("Give the doc a title of at most 512 bytes.");
  if (bytes(draft.markdown) > MAX_DOC_BYTES)
    throw new Error("Keep this doc under 32 KiB of Markdown.");
}
export function docTemplate(
  address: DocAddress,
  draft: DocDraft,
  previous?: Doc,
  operation: "create" | "update" | "delete" | "restore" = previous
    ? "update"
    : "create",
): DocTemplate {
  docAddress(address);
  if (operation !== "delete") validateDraft(draft);
  if (
    (operation === "create") === !!previous ||
    (previous &&
      (previous.id !== address.id || previous.channel !== address.channel))
  )
    throw new Error("The doc revision does not match this doc.");
  if (previous && !previous.editable)
    throw new Error("This doc uses an unsupported doc format.");
  const source = draft.restoreFrom;
  if (
    source &&
    (operation !== "restore" ||
      source.id !== address.id ||
      source.channel !== address.channel ||
      !source.editable ||
      source.deleted)
  )
    throw new Error("Choose a supported revision of this doc to restore.");
  const extra =
    operation === "delete"
      ? []
      : (source?.event.tags ?? previous?.event.tags ?? [])
          .filter(([key]) => key && !envelope.has(key))
          .map((tag) => [...tag]);
  // A root anchors a conversation; only prev links artifact revisions.
  const root = previous ? docTag(previous.event, "root") : undefined;
  const tags = [
    ["ar", "1"],
    ["d", address.id],
    ["h", address.channel],
    ["type", DOC_TYPE],
    ["op", operation],
    ...(previous
      ? [...(root ? [["root", root]] : []), ["prev", previous.revision]]
      : []),
    ...(operation === "delete"
      ? []
      : [["title", draft.title.trim()], ["doc", "1"], ...extra]),
  ];
  // Leave room for host-supplied attestation and the complete 64 KiB frame.
  const template = {
    kind: DOC_KIND,
    content: operation === "delete" ? "" : draft.markdown,
    tags,
  };
  if (tags.length > 250 || bytes(JSON.stringify(template)) > 60_000)
    throw new Error("This doc and its metadata exceed the save limit.");
  return template;
}

/** The current projection is relay-owned; never choose the newest timestamp locally. */
export async function readDoc(
  read: DocRead,
  address: DocAddress,
  signal?: AbortSignal,
) {
  docAddress(address);
  // A named d lookup includes the deletion head; current-list mode omits it.
  const events = await read(
    [
      {
        kinds: [DOC_KIND],
        "#h": [address.channel],
        "#d": [address.id],
        limit: 1,
        consistency: "strong",
      },
    ],
    signal,
  );
  signal?.throwIfAborted();
  const [event] = events;
  if (events.length !== 1 || !event)
    throw new Error("This doc is unavailable or you no longer have access.");
  const doc = parseDoc(event);
  if (!doc || doc.id !== address.id || doc.channel !== address.channel)
    throw new Error("The relay returned an unsupported doc.");
  return doc;
}
export class DocConflict extends Error {
  constructor(readonly current: Doc) {
    super(
      "This doc changed since you opened it. Your draft is kept; compare it with the latest revision before saving again.",
    );
  }
}
export async function saveDoc(
  read: DocRead,
  publish: DocPublish,
  base: Doc,
  draft: DocDraft,
  operation: "update" | "delete" | "restore" = "update",
  signal?: AbortSignal,
) {
  const current = await readDoc(read, base, signal);
  if (current.revision !== base.revision) throw new DocConflict(current);
  if (
    (operation === "update" && base.deleted) ||
    (operation === "restore" && !base.deleted)
  )
    throw new Error("Refresh the doc before changing its deletion state.");
  let saved: DocEvent;
  try {
    saved = await publish(docTemplate(base, draft, base, operation), signal);
  } catch (error) {
    if (error instanceof Error && /\bconflict:/.test(error.message)) {
      const latest = await readDoc(read, base, signal);
      if (latest.revision !== base.revision) throw new DocConflict(latest);
    }
    throw error;
  }
  const accepted = await readDoc(read, base, signal);
  if (accepted.revision !== saved.id) throw new DocConflict(accepted);
  return accepted;
}
export const docKey = (address: DocAddress) =>
  `${address.channel}:${address.id}`;

export { docLink as docUrl, parseDocLink as parseDocUrl } from "./links";
import { docLink as docUrl } from "./links";

export const docMarkdownLink = (doc: Doc, community: string) =>
  `[${doc.title.replace(/\s+/g, " ").replace(/[\\`*_[\]<>&~]/g, "\\$&")}](<${docUrl(doc, community)}>)`;

export async function readDocHistory(
  read: DocRead,
  address: DocAddress,
  offset = 0,
  signal?: AbortSignal,
) {
  docAddress(address);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000)
    throw new Error("History page is out of range.");
  const events = await read(
    [
      {
        kinds: [DOC_KIND],
        artifact: "history",
        "#h": [address.channel],
        "#d": [address.id],
        limit: DOC_PAGE,
        offset,
      },
    ],
    signal,
  );
  const docs = events.map(parseDoc);
  if (
    docs.some(
      (doc) => !doc || doc.id !== address.id || doc.channel !== address.channel,
    )
  )
    throw new Error("History contains an unsupported revision.");
  return {
    revisions: docs as Doc[],
    more: events.length === DOC_PAGE && offset < 10_000,
    limited: events.length === DOC_PAGE && offset === 10_000,
  };
}

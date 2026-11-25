import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  SearchChoices,
  type SearchDestination,
  type SearchGroup,
} from "../../app/shell/SearchChoices";
import {
  type PreviewCache,
  SearchPreview,
} from "../../app/shell/SearchPreview";
import type { RelaySession } from "../../features/relay/session";
import { formatItemTimestamp } from "../../shared/datetime";
import { avatarMedia } from "../../shared/avatar-source";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { FinderCorpus, FinderDoc, FinderResults } from "./corpus.ts";
import { useFinderAll, useFinderChannel, useFinderHeld } from "./search.ts";
import type { FinderSync } from "./sync";

export type FinderScope = "channel" | "buzz";

/** About `width` characters of `text` around its first match, with the
 * matched code points shifted into the window. */
export function excerpt(
  text: string,
  positions: readonly number[],
  width = 160,
) {
  const chars = [...text];
  const first = positions[0] ?? 0;
  let start = Math.max(0, first - Math.floor(width / 4));
  const space = chars.lastIndexOf(" ", start);
  if (start > 0 && space >= 0 && first - space < width / 2) start = space + 1;
  const end = Math.min(chars.length, start + width);
  const lead = start > 0 ? "…" : "";
  return {
    text: `${lead}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`,
    matches: positions
      .filter((p) => p >= start && p < end)
      .map((p) => p - start + lead.length),
  };
}

const emptyProfiles: ReturnType<RelaySession["profiles"]["snapshot"]> =
  new Map();
const noProfiles = () => emptyProfiles;
const noSubscribe = () => () => {};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  corpus: FinderCorpus;
  revision: number;
  session: RelaySession | undefined;
  sync?: FinderSync | undefined;
  currentChannelId?: string | undefined;
  scope: FinderScope;
  onScopeChange: (scope: FinderScope) => void;
  status?: ReactNode;
  openMessage: (doc: FinderDoc) => void;
};

export function FinderDialog(props: Props) {
  const [query, setQuery] = useState("");
  // Closing clears the text; switching scope keeps it.
  if (!props.open && query) setQuery("");
  const input = useRef<HTMLElement>(null);
  // The search field takes focus before the dialog notes what had it, so
  // keep that here, for closing to return to.
  const returnTo = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!props.open) return;
    const active = document.activeElement;
    // Nothing focused returns nowhere, not to the page's first control.
    returnTo.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [props.open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one budget per dialog opening and session, even when switching scopes.
  const opening = useMemo(() => ({}), [props.open, props.session]);
  const hold = useFinderHeld(props.sync, props.open);
  const contents = { ...props, query, setQuery, input, opening, hold };
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Find in your conversations"
      footerGap="none"
      motion="default"
      dismissOnOutsideClick
      presentation="search"
      size="wide"
      height="stable-tall"
      bodyLayout="flex"
      initialFocus={input}
      finalFocus={returnTo}
    >
      {props.open &&
        (props.scope === "buzz" && props.session ? (
          <AllResults {...contents} session={props.session} />
        ) : (
          <LocalResults {...contents} />
        ))}
    </Dialog>
  );
}

type Contents = Props & {
  query: string;
  setQuery: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  opening: object;
  hold: (docs: readonly FinderDoc[]) => void;
};

type Section = Readonly<{
  label: string;
  results: FinderResults;
  empty?: string | undefined;
}>;

function LocalResults(props: Contents) {
  const { corpus, query, revision, sync, scope, currentChannelId, opening } =
    props;
  const channelId = scope === "channel" ? currentChannelId : undefined;
  const { results, progress, keepGoing } = useFinderChannel({
    corpus,
    query,
    revision,
    sync,
    channelId,
    opening,
  });
  const channel = props.session?.channels.get?.(channelId ?? "");
  const where = channel?.name
    ? channel.channelType === "stream" || channel.channelType === "forum"
      ? `#${channel.name}`
      : channel.name
    : "this conversation";
  const footer = channelId ? (
    <LoadingRegion
      pending={!!progress?.loading}
      label="Searching older messages…"
      feedback={
        progress?.error && progress.loading ? (
          <p role="alert">Older messages could not load. Retrying…</p>
        ) : undefined
      }
    >
      <div
        className="flex flex-wrap items-center gap-2 px-3 text-body-sm text-subtle"
        aria-live="polite"
      >
        {progress && !progress.available
          ? "Join this conversation to search its history."
          : progress?.complete
            ? `Searched all of ${where}`
            : progress?.oldest
              ? `Searched back to ${new Date(progress.oldest * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
              : "Older messages are read when fewer than 20 match."}
        {progress?.capped && !progress.complete && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              props.input.current?.focus();
              keepGoing();
            }}
          >
            Keep going
          </Button>
        )}
      </div>
    </LoadingRegion>
  ) : (
    props.status
  );
  return (
    <Choices
      {...props}
      sections={[
        {
          label: query.trim() ? "Matches" : "Recent",
          results,
          empty: channelId
            ? progress?.complete
              ? "No messages in this channel match. Try fewer letters, or drop a word."
              : "No matches in the messages searched so far."
            : undefined,
        },
      ]}
      footer={footer}
      busy={!!progress?.loading}
    />
  );
}

/** The typed words, without `!exclusions` and `'` markers. */
const wordsOf = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && !word.startsWith("!"))
    .map((word) => word.replace(/^'/, ""))
    .filter(Boolean);

function AllResults(props: Contents & { session: RelaySession }) {
  const { query } = props;
  const { local, relay, search, asked } = useFinderAll(props);
  const retry = search.error ? search.retry : search.loadMore;
  const error = search.error || search.moreError;
  return (
    <Choices
      {...props}
      sections={[
        { label: query.trim() ? "Matches" : "Recent", results: local },
        ...(asked
          ? [
              {
                label: "More from all of Buzz",
                results: relay,
                empty: search.onlyExclusions
                  ? "Add a word to search the rest of Buzz."
                  : search.ambiguousAuthor
                    ? "More than one person has that name. Try a different search."
                    : search.loading || error
                      ? ""
                      : "Nothing more in Buzz.",
              },
            ]
          : []),
      ]}
      busy={search.loading || search.loadingMore}
      footer={
        asked ? (
          <LoadingRegion
            pending={search.loading || search.loadingMore}
            label="Searching Buzz…"
            feedback={
              error ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center gap-2 px-3 text-body-sm text-subtle"
                >
                  <span>Messages could not load. Try again.</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      props.input.current?.focus();
                      retry();
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : undefined
            }
          >
            {search.hasMore ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={search.loadingMore}
                onClick={() => {
                  props.input.current?.focus();
                  search.loadMore();
                }}
              >
                More messages
              </Button>
            ) : (
              props.status
            )}
          </LoadingRegion>
        ) : (
          props.status
        )
      }
    />
  );
}

function Choices({
  sections,
  footer,
  busy,
  ...props
}: Contents & {
  sections: readonly Section[];
  footer?: ReactNode;
  busy?: boolean;
}) {
  const {
    query,
    setQuery,
    input,
    session,
    scope,
    onScopeChange,
    currentChannelId,
    onOpenChange,
    openMessage,
    corpus,
  } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: previews must not cross sessions.
  const previews = useMemo<PreviewCache>(() => new Map(), [session]);
  const profiles = useSyncExternalStore(
    session?.profiles.subscribe ?? noSubscribe,
    session?.profiles.snapshot ?? noProfiles,
  );
  const hits = sections.flatMap((section) => section.results.hits);
  const byId = new Map(hits.map((hit) => [hit.doc.id, hit.doc]));
  const row = ({
    doc,
    positions,
  }: FinderResults["hits"][number]): SearchDestination => {
    const shown = excerpt(doc.text, positions);
    return {
      key: doc.id,
      label: shown.text || "Attachment",
      ...(shown.matches.length ? { matches: shown.matches } : {}),
      detail: `${doc.place} · ${doc.authorId === session?.viewer ? "You" : (profiles.get(doc.authorId)?.name ?? doc.author)} · ${formatItemTimestamp(doc.createdAt)}`,
      icon: ChatCircleIcon,
      avatar: {
        src: avatarMedia(profiles.get(doc.authorId)?.picture, session?.media),
        shape: "circle",
        name: doc.author,
      },
      peek: {
        kind: "message",
        channelId: doc.channelId,
        messageId: doc.id,
        createdAt: doc.createdAt,
        authorId: doc.authorId,
        text: doc.text,
        mentioned: { content: doc.text, mentions: [] },
      },
      run: () => {
        onOpenChange(false);
        openMessage(doc);
      },
    };
  };
  const groups: SearchGroup[] = sections.map(({ label, results, empty }) => {
    const rows = results.hits.map(row);
    return {
      label,
      destinations: rows,
      total: rows.length,
      count:
        results.total > rows.length
          ? `${rows.length} of ${results.total.toLocaleString()}`
          : undefined,
      empty:
        empty ??
        (corpus.size
          ? "Nothing matches. Try fewer letters, or drop a word."
          : "No messages indexed yet."),
    };
  });
  const terms = wordsOf(query);
  return (
    <SearchChoices
      label="Find in your conversations"
      query={query}
      onQueryChange={setQuery}
      input={input}
      open={props.open}
      highlightEmpty
      groups={groups}
      footer={footer}
      peek={{
        ranked: false,
        hints: (
          <Tabs
            label="Search in"
            variant="segmented"
            size="sm"
            value={scope}
            items={[
              {
                value: "channel",
                label: "This channel",
                disabled: !currentChannelId,
              },
              { value: "buzz", label: "All of Buzz" },
            ]}
            onValueChange={(next) => {
              onScopeChange(next);
              input.current?.focus();
            }}
          />
        ),
        busy: !!busy,
        preview: session
          ? (row, tone, follow) => (
              <SearchPreview
                session={session}
                cache={previews}
                row={row && byId.has(row.key) ? row : undefined}
                tone={tone}
                follow={follow}
                terms={terms}
                nameOf={(pubkey) =>
                  profiles.get(pubkey)?.name ??
                  hits.find((hit) => hit.doc.authorId === pubkey)?.doc.author ??
                  pubkey.slice(0, 10)
                }
                whereOf={(channelId) =>
                  hits.find((hit) => hit.doc.channelId === channelId)?.doc
                    .place ?? "Conversation"
                }
              />
            )
          : undefined,
      }}
    />
  );
}

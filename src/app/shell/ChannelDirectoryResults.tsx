import { useEffect, useMemo, useRef, useState } from "react";
import { channelIcon } from "../../features/channels/channel-icon";
import {
  useChannelDirectory,
  useMemberCounts,
} from "../../features/channels/useChannelDirectory";
import { useChannelRoster } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { matchName } from "../../features/search/match";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { UserIcon } from "../../shared/design-system/icons";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  SearchChoices,
  type SearchDestination,
  type SearchInputProps,
  type SearchViews,
} from "./SearchChoices";

const collator = new Intl.Collator();
/** Rows drawn at first, and added each time the last ones near the view:
 * the list looks whole, without thousands of rows to lay out at once. */
const FIRST_ROWS = 100;
const MORE_ROWS = 100;
const GROW_AHEAD = 25;

/** Read-only isn't unjoined: guests and cached channels are members too.
 * The same rule as All's "Public channel · not joined". */
const isMember = (channel: ChannelSummary) =>
  !channel.readOnly || !!channel.cached || channel.viewerRole === "guest";

/** Search's Channels view. With nothing typed it browses the open channels
 * the viewer can join, A–Z. Typed text matches those and the viewer's own
 * channels, which say they're joined, so a joined name is never a dead end. */
export function ChannelDirectoryResults({
  session,
  query,
  onQueryChange,
  input,
  open,
  views,
  openConversation,
  openPreview,
}: Pick<SearchInputProps, "query" | "onQueryChange" | "input" | "open"> & {
  session: RelaySession;
  views: SearchViews;
  openConversation: (channelId: string) => void;
  /** Opens an open channel's read-only preview, where Join lives. */
  openPreview: (channelId: string) => void;
}) {
  const list = useChannelRoster(session.channels);
  const ready = list.status === "ready";
  const directory = useChannelDirectory(session.channels, ready);
  const members = useMemberCounts(session.channels);
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  const { joined, member } = useMemo(
    () => ({
      joined: list.channels.filter(
        (channel) =>
          isMember(channel) &&
          !channel.archived &&
          !channel.huddle &&
          !channel.metadataPending &&
          (channel.channelType === "stream" || channel.channelType === "forum"),
      ),
      member: new Set(
        list.channels.filter(isMember).map((channel) => channel.id),
      ),
    }),
    [list.channels],
  );
  // Rows hold their places while later pages land: each page's new rows
  // join below the ones already shown, A–Z among themselves. A view opened
  // on a finished read is A–Z throughout.
  const arrival = useRef({
    directory: directory.directory,
    page: 0,
    seen: new Map<string, number>(),
  });
  if (arrival.current.directory !== directory.directory) {
    arrival.current.directory = directory.directory;
    arrival.current.page += 1;
  }
  // Every directory row takes the page it first landed on, before any
  // filtering or sorting; joined rows rank as if there from the start.
  for (const channel of directory.directory)
    if (!arrival.current.seen.has(channel.id))
      arrival.current.seen.set(channel.id, arrival.current.page);
  const landed = ({
    channel,
    joined,
  }: {
    channel: ChannelSummary;
    joined: boolean;
  }) =>
    joined ? 0 : (arrival.current.seen.get(channel.id) ?? arrival.current.page);
  // Sorted once per directory, query or roster change; counts and other
  // renders reuse it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `landed` reads the arrival ref the directory keys.
  const rows = useMemo(
    () =>
      [
        ...(needle
          ? joined.map((channel) => ({ channel, joined: true }) as const)
          : []),
        ...directory.directory
          .filter((channel) => !channel.archived && !member.has(channel.id))
          .map((channel) => ({ channel, joined: false }) as const),
      ]
        .flatMap((row) => {
          const match = needle
            ? matchName(row.channel.name, needle)
            : undefined;
          return !needle || match ? [{ ...row, match }] : [];
        })
        .sort(
          (a, b) =>
            (a.match?.rank ?? 0) - (b.match?.rank ?? 0) ||
            landed(a) - landed(b) ||
            Number(b.joined) - Number(a.joined) ||
            collator.compare(a.channel.name, b.channel.name) ||
            a.channel.id.localeCompare(b.channel.id),
        ),
    [directory.directory, needle, joined, member],
  );
  // A kept place reopens with its row drawn.
  const placed = () => {
    const key = views.place.anchor?.key ?? views.place.key;
    const index = key
      ? rows.findIndex(({ channel }) => `directory:${channel.id}` === key)
      : -1;
    return Math.max(FIRST_ROWS, index + MORE_ROWS);
  };
  const [drawing, setDrawing] = useState(() => ({
    needle,
    rows: placed(),
  }));
  // New typed text starts from the top, so it draws the first rows again.
  const drawn = drawing.needle === needle ? drawing.rows : FIRST_ROWS;
  const keyIndex = useMemo(
    () =>
      new Map(
        rows.map(({ channel }, index) => [`directory:${channel.id}`, index]),
      ),
    [rows],
  );
  const grow = (keys: readonly string[]) => {
    if (drawn >= rows.length) return;
    if (keys.some((key) => (keyIndex.get(key) ?? -1) >= drawn - GROW_AHEAD))
      setDrawing({ needle, rows: drawn + MORE_ROWS });
  };
  const destinations: SearchDestination[] = rows
    .slice(0, drawn)
    .map(({ channel, joined, match }) => {
      const people = members.counts.get(channel.id);
      const detail = [joined && "Joined", channel.description]
        .filter(Boolean)
        .join(" · ");
      return {
        key: `directory:${channel.id}`,
        label: channel.name,
        ...(match ? { matches: match.positions } : {}),
        ...(detail ? { detail } : {}),
        // The count's space is held from the start, so its arrival neither
        // makes a row taller nor trims the description again.
        trailing: (
          <span className="search-palette-count text-body-sm">
            {people !== undefined && (
              <>
                <UserIcon size={14} aria-hidden="true" />
                {people.toLocaleString()}
                <span className="sr-only">
                  {people === 1 ? " member" : " members"}
                </span>
              </>
            )}
          </span>
        ),
        icon: channelIcon(channel),
        run: () =>
          joined ? openConversation(channel.id) : openPreview(channel.id),
      };
    });
  const failed = list.status === "error" || directory.error;
  const settled = ready && !directory.loading && !failed;
  const count = rows.length;
  // One polite summary once a switch or filter settles, not per keystroke.
  const summary = settled
    ? needle
      ? `${count} ${count === 1 ? "channel matches" : "channels match"}`
      : `${count} ${count === 1 ? "channel" : "channels"} you can join`
    : "";
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(summary), 500);
    return () => clearTimeout(timer);
  }, [summary]);
  const retry = () => {
    if (list.status === "error")
      void (session.channels.refreshList
        ? session.channels.refreshList()
        : session.channels.ensureList());
    else directory.retry();
    input.current?.focus();
  };
  return (
    <SearchChoices
      query={query}
      onQueryChange={onQueryChange}
      input={input}
      open={open}
      views={views}
      highlightEmpty
      // Counts fill in for the rows in view, after the rows themselves.
      onRowsShown={(keys) => {
        members.show(keys.map((key) => key.slice("directory:".length)));
        grow(keys);
      }}
      groups={[
        {
          // Typed results sit under the Channels tab that names them.
          label: needle ? "Channels" : "Channels you can join",
          hideLabel: !!needle,
          destinations,
          total: count,
        },
      ]}
    >
      <p className="sr-only" aria-live="polite">
        {announced}
      </p>
      {count ? (
        <div
          className="space-y-2 px-3 text-body-sm text-subtle"
          aria-live="polite"
        >
          {failed && (
            <div>
              <p>Couldn’t load all channels.</p>
              <Button size="sm" variant="ghost" onClick={retry}>
                Retry channels
              </Button>
            </div>
          )}
          {settled && directory.partial && (
            <p>Only the newest open channels are shown.</p>
          )}
          {/* The first page shows at once; the rest join it as they land. */}
          {directory.loading && !failed && <p>Loading more channels…</p>}
        </div>
      ) : (
        // Nothing to list: the message takes the reserved results space.
        <div className="search-palette-centered" aria-live="polite">
          {failed ? (
            <>
              <p>Couldn’t load channels.</p>
              <Button size="sm" variant="ghost" onClick={retry}>
                Retry channels
              </Button>
            </>
          ) : settled ? (
            needle ? (
              <>
                <p>No matching channels.</p>
                <p>Private channels show up once someone invites you.</p>
              </>
            ) : (
              <p>
                {directory.partial
                  ? // A capped read can't say nothing else is left to join.
                    "You’ve joined all of the newest open channels."
                  : "You’ve joined every open channel."}
              </p>
            )
          ) : (
            // Rows show from the first page; this waits a second first.
            <LoadingRegion pending label="Loading channels…">
              {null}
            </LoadingRegion>
          )}
        </div>
      )}
    </SearchChoices>
  );
}

import { Avatar } from "../../shared/design-system/ui/Avatar";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArrowDownIcon,
  ArrowUpIcon,
} from "../../shared/design-system/icons/index";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CONVERSATION_LIST_LABEL, UNREAD_MARKERS } from "./conversation-rows";
import styles from "./Channels.module.css";

export type UnreadDmPreview = {
  name: string;
  src?: string | undefined;
  isAgent?: boolean | undefined;
};

type EdgeTarget = {
  row: HTMLButtonElement;
  channelId: string;
  attention: boolean;
};
type Edges = { above: EdgeTarget[]; below: EdgeTarget[] };

/** Geometry over rendered unread destinations, not another unread store. */
function unreadEdges(list: HTMLElement): Edges {
  const edges: Edges = { above: [], below: [] };
  const visible = new Set<string>();
  const viewport = list.getBoundingClientRect();
  if (!list.clientHeight || !viewport.width) return edges;
  const rows = new Set<HTMLButtonElement>();
  for (const marker of list.querySelectorAll(UNREAD_MARKERS)) {
    // Muting keeps unread evidence but excludes it from scroll notifications.
    if (marker.hasAttribute("data-channel-muted")) continue;
    const row = marker.closest("button");
    if (row) rows.add(row);
  }
  for (const row of rows) {
    const channelId = row.getAttribute("data-channel-id");
    if (!channelId) continue;
    // A collapsed section represents its hidden rows at the summary. Clicking
    // an edge cue expands that section before revealing the actual channel.
    const closed = row
      .closest("[data-sidebar-section]")
      ?.querySelector("details:not([open])");
    const anchor = closed?.querySelector("summary") ?? row;
    const rect = anchor.getBoundingClientRect();
    if (!rect.height || !rect.width) continue;
    const attention =
      row.getAttribute("data-channel-type") === "dm" ||
      row.querySelector('[data-priority="true"]') !== null ||
      row.querySelector("[data-channel-activity]") !== null;
    const target = { row, channelId, attention };
    if (rect.bottom <= viewport.top) edges.above.push(target);
    else if (rect.top >= viewport.top + list.clientHeight)
      edges.below.push(target);
    else visible.add(channelId);
  }
  // Count destinations, not repeated rows. Any visible copy wins; otherwise
  // keep the nearest copy for reveal and for the avatar ordering.
  for (const edge of ["above", "below"] as const) {
    const seen = new Set(visible);
    const targets = edge === "above" ? edges[edge].reverse() : edges[edge];
    edges[edge] = targets.filter(({ channelId }) => {
      if (seen.has(channelId)) return false;
      seen.add(channelId);
      return true;
    });
    if (edge === "above") edges[edge].reverse();
  }
  return edges;
}

export function SidebarUnread({
  children,
  listRef,
  dmPreviews,
}: {
  children: ReactNode;
  listRef?: RefObject<HTMLElement | null>;
  dmPreviews?: ReadonlyMap<string, UnreadDmPreview>;
}) {
  const ownList = useRef<HTMLElement>(null);
  const list = listRef ?? ownList;
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ above: [], below: [] });
  useEffect(() => {
    const viewport = list.current;
    const rows = content.current;
    if (!viewport || !rows) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = unreadEdges(viewport);
      setEdges((previous) =>
        (["above", "below"] as const).every(
          (edge) =>
            previous[edge].length === next[edge].length &&
            previous[edge].every(
              (target, i) =>
                target.row === next[edge][i]?.row &&
                target.channelId === next[edge][i]?.channelId &&
                target.attention === next[edge][i]?.attention,
            ),
        )
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(rows);
    const mutations = new MutationObserver(schedule);
    mutations.observe(rows, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "open",
        "data-channel-unread",
        "data-channel-muted",
        "data-channel-activity",
        "data-channel-type",
        "data-channel-id",
        "data-priority",
        "data-moving",
      ],
    });
    viewport.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      viewport.removeEventListener("scroll", schedule);
    };
  }, [list]);
  const reveal = (edge: keyof Edges) => {
    const viewport = list.current;
    if (!viewport) return;
    // Recheck at activation: unread/roster changes may precede the queued frame.
    const targets = unreadEdges(viewport)[edge];
    const target = edge === "above" ? targets.at(-1) : targets[0];
    if (!target) return;
    const { row } = target;
    const section = row.closest("[data-sidebar-section]");
    const disclosure = section?.querySelector("details");
    if (disclosure && !disclosure.open) {
      // Use the section's controlled toggle path so React removes `inert`
      // before focus enters the newly expanded content.
      disclosure.querySelector<HTMLElement>("summary")?.click();
    }
    requestAnimationFrame(() => {
      const rect = row.getBoundingClientRect();
      viewport.scrollTop +=
        rect.top -
        viewport.getBoundingClientRect().top -
        (viewport.clientHeight - rect.height) / 2;
      // Continue keyboard navigation at the revealed row, not the start of the
      // roster. Its existing focus preparation still applies; focus is not selection.
      row.focus({ preventScroll: true });
    });
  };
  const edgeCues = (["above", "below"] as const).map((edge) => {
    const count = edges[edge].length;
    const nearestFirst =
      edge === "above" ? [...edges[edge]].reverse() : edges[edge];
    const previews = nearestFirst
      .flatMap(({ channelId }) => {
        const preview = dmPreviews?.get(channelId);
        return preview ? [{ channelId, ...preview }] : [];
      })
      .slice(0, 3);
    const Icon = edge === "above" ? ArrowUpIcon : ArrowDownIcon;
    // Spend the strong fill only when a DM, a mention of you or a thread
    // reply waits past this edge; ordinary unread uses the quiet gray fill.
    const attention = edges[edge].some((target) => target.attention);
    return (
      <div
        className={styles.unreadEdge}
        data-edge={edge}
        key={edge}
        data-attention={attention}
        data-visible={count > 0}
        inert={count === 0}
        aria-hidden={count === 0}
      >
        <Button
          variant={attention ? "prominent" : "subtle"}
          aria-label={`${count} unread ${count === 1 ? "conversation" : "conversations"} ${edge}`}
          data-edge={edge}
          data-attention={attention}
          size="xs"
          shape="capsule"
          type="button"
          onClick={() => reveal(edge)}
        >
          <Icon size={15} aria-hidden="true" />
          {previews.length > 0 && (
            <span className={styles.unreadDmPreviews} aria-hidden="true">
              <span className={styles.unreadDmStack}>
                {previews.map((preview, index) => (
                  <span
                    key={preview.channelId}
                    className={styles.unreadDmAvatar}
                    data-unread-dm={preview.channelId}
                    style={{ zIndex: previews.length - index }}
                  >
                    <Avatar
                      src={preview.src}
                      alt=""
                      fallback={preview.name}
                      size="fill"
                      shape={preview.isAgent ? "squircle" : "circle"}
                    />
                  </span>
                ))}
              </span>
              <span>·</span>
            </span>
          )}
          <span className={styles.unreadEdgeLabel}>{count} unread</span>
        </Button>
      </div>
    );
  });
  return (
    <SidebarList
      navigation={{ label: CONVERSATION_LIST_LABEL, ref: list }}
      contentRef={content}
      overlay={edgeCues}
    >
      {children}
    </SidebarList>
  );
}

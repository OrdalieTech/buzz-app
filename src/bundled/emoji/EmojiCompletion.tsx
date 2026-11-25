import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import { CustomEmoji } from "./CustomEmoji";
import {
  exactEmoji,
  searchEmoji,
  searchCustomEmoji,
  type EmojiMatch,
} from "./emoji-search";
import { emojiUsage, recordEmojiUsage } from "./emoji-usage";

const OPTICAL_SAMPLE_SIZE = 64;
const OPTICAL_CANVAS_SIZE = 128;
const opticalCenterCache = new Map<string, number>();

function emojiInkCenter(text: string, font: string) {
  const key = `${font}\n${text}`;
  const cached = opticalCenterCache.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = OPTICAL_CANVAS_SIZE;
  canvas.height = OPTICAL_CANVAS_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return OPTICAL_CANVAS_SIZE / 2;
  context.font = font;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillText(text, OPTICAL_CANVAS_SIZE / 2, 88);
  const pixels = context.getImageData(
    0,
    0,
    OPTICAL_CANVAS_SIZE,
    OPTICAL_CANVAS_SIZE,
  ).data;
  let top = OPTICAL_CANVAS_SIZE;
  let bottom = -1;
  for (let y = 0; y < OPTICAL_CANVAS_SIZE; y += 1) {
    for (let x = 0; x < OPTICAL_CANVAS_SIZE; x += 1) {
      if ((pixels[(y * OPTICAL_CANVAS_SIZE + x) * 4 + 3] ?? 0) > 8) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  const center = bottom < 0 ? OPTICAL_CANVAS_SIZE / 2 : (top + bottom) / 2;
  opticalCenterCache.set(key, center);
  return center;
}

function NativeEmojiPreview({ emoji }: { emoji: string }) {
  const element = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const center = () => {
      const style = getComputedStyle(node);
      const font = `${style.fontStyle} ${style.fontWeight} ${OPTICAL_SAMPLE_SIZE}px ${style.fontFamily}`;
      const referenceCenter = emojiInkCenter("😀", font);
      const emojiCenter = emojiInkCenter(emoji, font);
      const scale = Number.parseFloat(style.fontSize) / OPTICAL_SAMPLE_SIZE;
      const offset = Math.max(
        -3,
        Math.min(3, (referenceCenter - emojiCenter) * scale),
      );
      node.style.setProperty("--emoji-optical-offset", `${offset}px`);
    };
    const list = node.closest<HTMLElement>('[role="listbox"]');
    if (!list || typeof IntersectionObserver === "undefined") {
      center();
      return;
    }
    const nodeBounds = node.getBoundingClientRect();
    const listBounds = list.getBoundingClientRect();
    if (
      nodeBounds.bottom >= listBounds.top - 96 &&
      nodeBounds.top <= listBounds.bottom + 96
    ) {
      center();
      return;
    }
    // The search can return the full catalog, so measure offscreen glyphs only
    // shortly before they scroll into view.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        center();
        observer.disconnect();
      },
      { root: list, rootMargin: "96px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [emoji]);
  return (
    <span ref={element} data-native-emoji="">
      {emoji}
    </span>
  );
}

export function EmojiCompletion({
  session,
  scope,
  query,
  publish,
}: ComposerCompletionProps) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const [attempt, retry] = useState(0);
  useEffect(() => {
    void session.emoji.ensure("foreground");
  }, [session]);
  useEffect(() => {
    void attempt; // Explicit retry repeats this query even when catalog data is unchanged.
    let live = true;
    let withdraw: (() => void) | false = false;
    const custom = catalog.entries.filter((item) => !!session.media(item.url));
    const uses = emojiUsage(scope);
    const items = (matches: readonly EmojiMatch[]) => {
      const counts = new Map<string, number>();
      for (const item of matches)
        counts.set(item.shortcode, (counts.get(item.shortcode) ?? 0) + 1);
      return matches.map((item) => ({
        id: item.id,
        label: `:${item.shortcode}:`,
        ...((counts.get(item.shortcode) ?? 0) > 1
          ? { detail: item.url ? "Community emoji" : "Unicode emoji" }
          : {}),
        preview: item.url ? (
          <CustomEmoji
            emoji={{ shortcode: item.shortcode, url: item.url }}
            media={session.media}
          />
        ) : (
          <NativeEmojiPreview emoji={item.text} />
        ),
        edit: { text: item.text },
        onSelect: () => recordEmojiUsage(scope, item.id),
      }));
    };
    // Suggestions may be partial; automatic replacement needs both catalogs.
    const retrySearch = () => {
      retry((value) => value + 1);
      if (catalog.status === "error") void session.emoji.refresh();
    };
    withdraw = publish({
      items: items(searchCustomEmoji(query.query, custom, uses)),
      status: "Searching emoji…",
    });
    void searchEmoji(query.query, custom, uses)
      .then((matches) => {
        if (!live) return;
        if (withdraw) withdraw();
        withdraw = publish({
          items: items(matches),
          ...(catalog.status === "ready"
            ? { spaceId: exactEmoji(query.query, matches) }
            : {}),
          ...(catalog.status === "error"
            ? {
                status: "Community emoji unavailable; Unicode results shown.",
                retry: retrySearch,
              }
            : {}),
        });
      })
      .catch(() => {
        if (!live) return;
        if (withdraw) withdraw();
        withdraw = publish({
          items: items(searchCustomEmoji(query.query, custom, uses)),
          status: "Unicode emoji unavailable. Custom matches shown.",
          retry: retrySearch,
        });
      });
    const unsubscribe = session.emoji.subscribe(() => {
      live = false; // Late search completion cannot revive the previous catalog.
      if (withdraw) withdraw();
    });
    return () => {
      live = false;
      unsubscribe();
      if (withdraw) withdraw();
    };
  }, [session, scope, query.query, publish, catalog, attempt]);
  return null;
}

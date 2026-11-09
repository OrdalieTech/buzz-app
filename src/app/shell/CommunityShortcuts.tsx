import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Communities } from "../../features/communities/service";
import type { SearchServices } from "./PageSearch";

/** After Search and Settings, before tabs and focus. */
const ORDER = 77;

/**
 * Slack's workspace keys, over the community switcher's own order: ⌘1 is its
 * first entry (Personal space) and ⌘2–⌘9 the communities after it. ⌘⇧] and
 * ⌘⇧[ step through the same list and wrap. Keys with no entry are left alone.
 */
export function CommunityShortcuts({
  communities,
  shortcuts,
  onSelect,
}: {
  communities: Communities;
  shortcuts: SearchServices["shortcuts"];
  onSelect?: ((id: string | null) => void) | undefined;
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  // Registrations read the current list and handler when pressed.
  const latest = useRef({ client, onSelect });
  latest.current = { client, onSelect };
  useEffect(() => {
    const entries = () => [
      null,
      ...latest.current.client.memberships.map(({ id }) => id),
    ];
    const select = (id: string | null) => {
      const { onSelect } = latest.current;
      if (onSelect) onSelect(id);
      else communities.select(id);
    };
    const step = (by: 1 | -1) => {
      const list = entries();
      const index = list.indexOf(latest.current.client.selected);
      select(list[(index + by + list.length) % list.length] ?? null);
    };
    const removes = [
      ...Array.from({ length: 9 }, (_, index) =>
        shortcuts.registerHost({
          id: `switch-community-${index + 1}`,
          title:
            index === 0
              ? "Switch to Personal space"
              : `Switch to community ${index + 1} in the switcher`,
          binding: { key: String(index + 1), mod: true },
          order: ORDER + index / 100,
          allowInEditable: true,
          when: () => index < entries().length,
          run: () => select(entries()[index] ?? null),
        }),
      ),
      ...(
        [
          ["next-community", "Switch to next community", "]", "}", 1],
          ["previous-community", "Switch to previous community", "[", "{", -1],
        ] as const
      ).map(([id, title, key, shifted, by], index) =>
        shortcuts.registerHost({
          id,
          title,
          // Shift turns brackets into braces on common layouts.
          binding: [
            { key, mod: true, shift: true },
            { key: shifted, mod: true, shift: true },
          ],
          order: ORDER + (10 + index) / 100,
          allowInEditable: true,
          when: () => entries().length > 1,
          run: () => step(by),
        }),
      ),
    ];
    return () => {
      for (const remove of removes) remove();
    };
  }, [shortcuts, communities]);
  return null;
}

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Communities } from "../../features/communities/service";
import type { SearchServices } from "./PageSearch";

/** After Search and Settings, before tabs and focus. */
const ORDER = 77;

/**
 * Slack's workspace keys, over the community switcher's own order: ⌘1–⌘9 are
 * its communities, and Personal space has no number. ⌘⇧] and ⌘⇧[ step through
 * Personal space and the communities and wrap. Keys with no entry are left alone.
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
    const ids = () => latest.current.client.memberships.map(({ id }) => id);
    const entries = () => [null, ...ids()];
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
          // New ids, so rebinds saved for the old numbering do not carry over.
          id: `community-${index + 1}`,
          title: `Switch to community ${index + 1} in the switcher`,
          binding: { key: String(index + 1), mod: true },
          order: ORDER + index / 100,
          allowInEditable: true,
          when: () => index < ids().length,
          run: () => {
            const id = ids()[index];
            if (id) select(id);
          },
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

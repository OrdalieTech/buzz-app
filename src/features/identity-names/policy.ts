import { npubEncode } from "nostr-tools/nip19";

export type NamingIdentity = {
  pubkey: string;
  name: string;
  isAgent?: boolean;
  ownerPubkey?: string;
};

/** A scope's naming input: its selected keys and the owners of selected
 * agents. Rows outside it only supply those owners' names. `rowsOf` returns
 * every row for a key. The name directory and this policy share this rule. */
export function scopeKeys(
  selection: Iterable<string>,
  rowsOf: (key: string) => Iterable<NamingIdentity>,
): Set<string> {
  const selected = [...selection].map((key) => key.toLowerCase());
  const keys = new Set(selected);
  for (const key of selected)
    for (const row of rowsOf(key))
      if (row.ownerPubkey) keys.add(row.ownerPubkey.toLowerCase());
  return keys;
}

/** Display policy only. Neither a readable owner nor a key suffix grants authority. */
export function resolveIdentityNames(
  identities: readonly NamingIdentity[],
  viewer?: string,
  candidates?: readonly string[],
) {
  viewer = viewer?.toLowerCase();
  const selected =
    candidates && new Set(candidates.map((key) => key.toLowerCase()));
  // Outside a selection, rows only supply agent owners' names. Drop the rest
  // first: callers pass the whole directory for scopes of a few keys.
  if (selected) {
    const byKey = new Map<string, NamingIdentity[]>();
    for (const row of identities) {
      const key = row.pubkey.toLowerCase();
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const keys = scopeKeys(selected, (key) => byKey.get(key) ?? []);
    identities = identities.filter((row) => keys.has(row.pubkey.toLowerCase()));
  }
  const unique = new Map(
    identities.map((row) => [
      row.pubkey.toLowerCase(),
      { ...row, ownerPubkey: row.ownerPubkey?.toLowerCase() },
    ]),
  );
  // Compare every displayed alias, but repeated configurations of one key
  // are not competing identities. The last alias supplies that key's result.
  const aliases = new Map(
    identities.map((identity) => [
      JSON.stringify([identity.pubkey.toLowerCase(), identity.name.trim()]),
      { ...identity, ownerPubkey: identity.ownerPubkey?.toLowerCase() },
    ]),
  );
  const rows = [...aliases.values()]
    .filter(
      (identity) => !selected || selected.has(identity.pubkey.toLowerCase()),
    )
    .map((identity) => {
      const key = identity.pubkey.toLowerCase();
      const mine =
        !!viewer && (key === viewer || identity.ownerPubkey === viewer);
      return {
        key,
        identity,
        base: identity.name.trim(),
        label: identity.name.trim(),
        priority: identity.isAgent ? (mine ? 2 : 3) : key === viewer ? 0 : 1,
        mine,
        length: 0,
        suffix: undefined as string | undefined,
      };
    });
  // Recheck finished labels, including collisions with literal names and suffixes.
  for (;;) {
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.label) ?? [];
      group.push(row);
      groups.set(row.label, group);
    }
    const collisions = [...groups.values()].filter(
      (group) => new Set(group.map((row) => row.key)).size > 1,
    );
    if (!collisions.length) break;
    for (const group of collisions) {
      const best = Math.min(...group.map((row) => row.priority));
      const winners = new Set(
        group.filter((row) => row.priority === best).map((row) => row.key),
      );
      const changing = group.filter(
        (row) => winners.size !== 1 || !winners.has(row.key),
      );
      let qualified = false;
      for (const row of changing) {
        const owner = row.identity.ownerPubkey
          ? unique.get(row.identity.ownerPubkey)?.name.trim()
          : undefined;
        const readable =
          row.identity.isAgent && !row.length
            ? !row.mine && owner
              ? `${owner}’s ${row.identity.name.trim()}`
              : group.some((other) => !other.identity.isAgent)
                ? `${row.identity.name.trim()} (agent)`
                : row.base
            : row.base;
        if (readable !== row.base) {
          row.base = readable;
          row.label = readable;
          qualified = true;
        }
      }
      if (qualified) continue;
      for (const row of changing) {
        row.length = row.length ? row.length + 1 : 4;
        const npub = npubEncode(row.key);
        // Literal names can occupy even the full key. Keep advancing beyond it;
        // finitely many names cannot exhaust this identity-specific sequence.
        row.suffix =
          row.length <= npub.length
            ? npub.slice(-row.length)
            : `${npub} · ${row.length - npub.length}`;
        row.label = `${row.base} · ${row.suffix}`;
      }
    }
  }
  return new Map(
    rows
      .filter(
        (row) => row.identity.name.trim() === unique.get(row.key)?.name.trim(),
      )
      .map((row) => [row.key, { name: row.label, qualifier: row.suffix }]),
  );
}

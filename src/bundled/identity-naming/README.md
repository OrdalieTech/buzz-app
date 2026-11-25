# Identity Naming

Helps you tell people and agents apart when they share a name, by adding a short label like “Sam’s Helper” or “(agent)”.

## Getting started

Names across Buzz are labeled automatically.

---

# Contextual identity names

`version 1` · `client display contract` · `no wire changes`

## Abstract

This contract gives different public keys distinct readable labels in a client
view. It prefers humans before agents, then the viewer's identities before other
identities. It uses owner names before public-key suffixes. It compares only the
identities relevant to that view, not every identity the client has ever seen.

The `buzz.identity-naming` plugin registers this policy through the shared
identity-names service. This directory owns the spec and portable fixtures;
the resolver currently lives in `src/features/identity-names/policy.ts`.

This is an extraction of the behavior merged in
[buzz-app #167](https://github.com/block/buzz-app/pull/167), at
`82bb3a6`. It is not a new Nostr event kind, ownership protocol, or claim that
other clients already implement these rules. The normative resolver below and
[portable fixtures](identity-names.fixtures.json) are independent of React,
plugins, storage, and transport. The final section describes the current desktop
adapter separately.

MUST, MUST NOT, SHOULD, and MAY have their RFC 2119 meanings.

## Scope and authority

A **key** is a Nostr public key, not a name, persona, local configuration ID,
process, or community membership. Two configurations with the same key are one
identity even when they have different displayed names (**aliases**).

Labels are presentation only. Clients MUST retain the exact key for profile
navigation, mentions, notifications, and other identity-bound actions. Labels
MUST NOT grant control, prove ownership, substitute one agent instance for
another, change stored configuration names, or change signed message text and
recipient tags. A configuration editor MUST retain its exact configuration ID.

This contract does not specify profile validation, ownership verification,
agent admission, discovery completeness, sorting, layout, animation, or search.
It does not solve visual impersonation (for example, Unicode confusables).

## Inputs and outputs

The resolver takes:

- An ordered list of identity facts: `pubkey`, `name`, optional `isAgent`, and
  optional `ownerPubkey`. Keys MUST be valid 32-byte keys encoded as 64 hex
  characters. `name` is a string. Missing `isAgent` means false. An owner fact
  does not by itself set `isAgent`.
- An optional viewer key. Missing viewer means no identity is "mine".
- An optional candidate-key set. Omission selects all supplied facts; an empty
  set selects none. A selected key with no fact produces no result.

The caller MUST choose names and classification facts before resolving labels.
Missing profiles and application-specific fallback text belong to that step,
not to collision resolution. An empty name is allowed by the resolver and is
compared like any other string; clients SHOULD supply a useful fallback instead.
Invalid keys are outside this resolver's contract and MUST be handled before it
runs, not converted into fabricated identities.

The result is a map from lowercase key to `{name, qualifier}`. `name` is the full
label. `qualifier` is absent unless a key suffix was added, in which case it is
only the suffix, without the preceding ` · `. Readable owner prefixes and
` (agent)` are part of `name`, not `qualifier`. Map iteration order has no meaning.

### Normalization and aliases

1. Lowercase all identity, owner, viewer, and candidate keys.
2. Trim names at both ends using the following code points (ECMAScript
   `String.trim`): U+0009–000D, U+0020, U+00A0, U+1680, U+2000–200A,
   U+2028–2029, U+202F, U+205F, U+3000, and U+FEFF.
3. Compare names and completed labels by exact string equality. MUST NOT case
   fold, normalize Unicode, collapse interior whitespace, or strip punctuation.
   `Honey` and `honey` are different; so are composed and decomposed accents.
4. Keep the last supplied fact for each key as its **preferred fact**. This
   selects the alias returned for that key and the raw name used when that key
   is looked up as an owner, even if the owner is outside the candidate set.
5. Keep one working row per `(key, trimmed name)` pair; the last fact for that
   pair supplies its metadata. Do not collapse different aliases of one key.
6. Select working rows by the candidate set. All selected aliases participate
   in collision checks, including aliases that will not be returned.

Callers SHOULD supply consistent classification and owner facts for a key's
aliases. Input order matters for last-fact selection, not as a way to award a
plain label to one of two equally ranked keys. To request a particular alias,
a caller can append that alias's fact after the complete displayed fact list.

## Choosing the comparison context

Clients implementing the same surface SHOULD use the following contexts. Two
clients can guarantee equal output only with equal effective facts, viewer,
preferred aliases, and candidate set. Loading more facts or changing the viewer
can legitimately change a label.

| Surface | Candidates |
| --- | --- |
| Channel or thread identities | Channel members, plus the requested identity for a historical/non-member reference |
| Mention picker | All actual selectable mention choices, before text-search filtering; not only matching search results |
| Composer's selected mentions | The destination's members (or its explicit recipient roster), minus known-archived identities, plus already selected recipient keys; not the chooser's agent or invitation choices |
| DM participant labels | That DM's participants |
| Agent directory/management | The displayed collection's keys and all displayed configured aliases, including cross-community aliases |
| Local activity/filter choices | The local choice set; unknown keys use the surface's existing key-label fallback |

Owners may be supplied as lookup facts without making them collision candidates.
Clients MUST NOT add the whole global profile cache to an explicitly scoped
candidate set. A requested identity outside that set SHOULD be added before
resolution. The low-level resolver does not add it automatically.

Labels MUST be recomputed from original facts when relevant names, ownership
hints, classification, candidates, viewer, or configured aliases change. Do not
feed a previously generated label back as an original name. Clients MAY cache
results, provided all these inputs are part of invalidation. Incomplete facts
are not proof of global uniqueness; this contract gives local disambiguation,
not a stable network-wide nickname registry.

## Resolution algorithm (normative)

### 1. Initialize each selected alias row

For each row set `base = trimmed name`, `label = base`, `length = 0`, and no
`qualifier`. Set `mine` only if a viewer exists and either the row key or its
owner key equals the viewer.

Assign a fixed priority (lower wins):

| Priority | Row |
| --- | --- |
| 0 | Non-agent whose key is the viewer |
| 1 | Any other non-agent |
| 2 | Agent that is mine |
| 3 | Any other agent |

Human priority always wins over agent priority. "Mine" for a human means the
viewer itself, not another human with an owner field. An agent without an owner
is not mine merely because the viewer is also absent.

### 2. Find collisions and choose rows that may change

Group **all current labels** by exact equality. A group is a collision only if
it contains more than one distinct key. Several aliases of one key alone do not
collide.

For each collision group, find the minimum priority and the distinct keys at
that priority. If exactly one key has that priority, all rows for that key keep
the label in this round; the other rows may change. Otherwise every row in the
group may change. Do not choose an arbitrary equal-priority winner.

### 3. Try readable qualification first

For each row allowed to change, if it is an agent and has not yet received a key
suffix (`length == 0`):

1. If it is not mine and its owner has a non-empty preferred trimmed name in
   the full fact list, propose `<owner>’s <original trimmed name>`.
2. Otherwise, if **any row in this collision group** is a non-agent, propose
   `<original trimmed name> (agent)`.
3. Otherwise leave its current base unchanged.

For all other rows, leave the base unchanged. Owner names here are raw preferred
names, not recursively resolved owner labels. The possessive is always U+2019
followed by `s` and one ASCII space, even for a name ending in `s`.

Apply changed readable bases as both `base` and `label`. If at least one row in
this group changed its readable base, add **no key suffix to any row in that
group in this round**. Recheck on the next round instead. This matters: an
unknown-owner agent can remain plain when another agent gains an owner prefix.

### 4. Add or extend key suffixes when readable labels did not change

If step 3 changed no readable base in the group, update every row allowed to
change:

- Set `length` to 4 if zero; otherwise increment it by one.
- Encode the row's public key as its lowercase NIP-19 Bech32 `npub`, including
  prefix and checksum. Suffixes use the **end of the complete encoded string**,
  not the end of the hex key or checksum-free payload.
- If `length` is at most the npub string length, set `qualifier` to its last
  `length` characters.
- Otherwise set `qualifier` to `<full npub> · <length minus npub length>`, with
  the counter in ordinary decimal, starting at 1 and without leading zeros.
- Set `label = base + " · " + qualifier` (ASCII spaces, U+00B7 middle dot).

Do not reset a readable base when adding a suffix. Do not extend rows outside
this group or a winning row that is not allowed to change.

### 5. Repeat and return preferred aliases

After processing the collision groups from the start of the round, regroup all
labels and repeat steps 2–4 until no label belongs to two distinct keys. New
labels MUST be checked against literal names, other generated labels, and all
selected aliases. Priority applies again in every round, even to generated
labels. Do not reserve original names unconditionally or suffix all rows once
and assume the result is unique.

The counter after a full npub MUST keep advancing if occupied. Never clamp at
the full npub: literal names can occupy it and several counter labels too.
For finite inputs the suffix sequence can escape those occupied labels.

Return each selected key's row whose original trimmed name equals its preferred
fact's trimmed name. Other aliases participated in the comparison but do not
create extra entries in this key-indexed result.

## Examples

Here the viewer is Logan; Wes is another owner. All agents are named Honey.
`<a4>` and `<b4>` stand for the last four npub characters of distinct agent keys;
these examples assume those suffixes differ and no other labels collide.

| Identities in the context | Labels, in the same order |
| --- | --- |
| One Wes-owned agent | `Honey` |
| Human, Logan's agent, Wes's agent | `Honey`; `Honey (agent)`; `Wes’s Honey` |
| Logan's agent, Wes's agent | `Honey`; `Wes’s Honey` |
| Two Logan-owned agents | `Honey · <a4>`; `Honey · <b4>` |
| Two Wes-owned agents | `Wes’s Honey · <a4>`; `Wes’s Honey · <b4>` |
| Human and two Logan-owned agents | `Honey`; `Honey (agent) · <a4>`; `Honey (agent) · <b4>` |
| Two humans, neither the viewer | `Honey · <a4>`; `Honey · <b4>` |
| Viewer named Honey, another human named Honey | `Honey`; `Honey · <b4>` |
| Unknown-owner agent, Wes's agent | `Honey`; `Wes’s Honey` |

If a human's literal name is `Wes’s Honey`, that human wins a collision with a
generated agent label of the same text. The agent becomes `Wes’s Honey · <b4>`.
If a literal name occupies that result too, the algorithm rechecks and extends
only the rows that lose or tie at that new collision.

## Conformance fixtures

[identity-names.fixtures.json](identity-names.fixtures.json) contains versioned
semantic inputs, not signed events. Each case has `identities`, optional `viewer`
and `candidates`, and an `expected` map. Absent qualifier is encoded as JSON
`null`. Compare map keys and complete values, not map iteration order. Keep input
array order: it selects preferred aliases. Expected results are stored literals;
ports MUST NOT generate their expected results with their own resolver.

Cases cover priority, unknown owners/viewer, owner lookup outside the scope,
empty scope, key normalization, exact Unicode comparison, alias selection,
literal/generated collisions, suffix extension, and occupied full-key counters.
The fixtures test the pure resolver. Adapter selection, fact validation, and
identity-bound actions still need client-specific tests.

Run the fixtures against the desktop policy from the repository root:

```sh
bin/pnpm exec vitest run src/features/identity-names/policy.test.ts
```

## Desktop adapter (informative, not an authority protocol)

At the extraction baseline, [directory.ts](../../features/identity-names/directory.ts)
constructs facts from public profiles, ready agent-library records, the
viewer's local agents in the current community, and view-local display
facts. Local non-empty names take precedence over library names in that
community. The first
library record per key uses its trimmed name, then the profile name, then
`Agent`. Library/local naming records are classified as agents but do not by
themselves invent an owner key. Explicit display facts replace that key's normal
fact and can carry multiple aliases. The requested key is added to an explicit
candidate set.

[profiles.ts](../../features/relay/profiles.ts) selects the latest kind-0 profile,
uses non-blank `display_name` before `name`, and otherwise uses a short hex-key
fallback. The naming adapter excludes these synthetic names from public-name
lookup and collision candidates, while preserving profile metadata for library,
local, and explicit display aliases. Genuine names that resemble keys remain
valid. Agent hints come from `is_agent: true`, `isAgent: true`, or a
structurally recognized `auth` tag. That fold extracts an owner hint from the
latter; the naming path does **not** verify the owner's attestation signature.
Clients MUST NOT use this display hint as authorization. Missing owner names
simply remove the owner-prefix option; no invented owner or extra naming-only
network fetch is required.

Without an active naming provider, the desktop service falls back to public
profile names and caller fallbacks; that mode does not promise disambiguation.
The policy is replaceable, but a client claiming version-1 conformance must
produce this contract's output for the same inputs. Localized punctuation or a
different case-folding rule is a different policy, not byte-identical conformance.

## Sources and specification precedents

- Algorithm: [policy.ts](../../features/identity-names/policy.ts) and
  [policy.test.ts](../../features/identity-names/policy.test.ts).
- Context and fact selection: [directory.ts](../../features/identity-names/directory.ts),
  [react.ts](../../features/identity-names/react.ts), and
  [use-mention-choices.ts](../mentions/use-mention-choices.ts).
- block/buzz, inspected at `797012ff01a6d499959b45ed2e56f7927c6a4d6b`:
  [NIP-MP](https://github.com/block/buzz/blob/797012ff01a6d499959b45ed2e56f7927c6a4d6b/docs/nips/NIP-MP.md)
  supplies the abstract/non-goals/normative-rules pattern;
  [fold fixtures](https://github.com/block/buzz/blob/797012ff01a6d499959b45ed2e56f7927c6a4d6b/docs/nips/NIP-MP.fold-fixtures.json)
  supply the portable semantic-input pattern;
  [agent profile identity](https://github.com/block/buzz/blob/797012ff01a6d499959b45ed2e56f7927c6a4d6b/docs/agent-profile-identity.md)
  supplies the exact-key versus persona/control boundary.

This document stays a client contract rather than taking a NIP number because
it introduces no event format or relay behavior. Keep one canonical spec and
fixture set; other client repositories can link here or vendor a pinned version.

# Build configuration

A distributor configures Buzz at build time. Every input below is compiled into
the app, so changing the launched app's environment has no effect; rebuild to
change one. Builds embed these values as readable data, so **never put a key,
token or other secret in one**. Open-source builds leave them all unset.

## How values are read

- Set each input in repository-root `.env.local` or in the environment of the
  build command. A process value wins, including an explicit empty one.
- `just desktop` and `just desktop-bundle` pass every `BUZZ_` value from
  `.env.local` to Vite, Cargo and the native app, so both halves of the build
  agree. Other names stay out, as do the release-only `BUZZ_UPDATER_*` inputs.
  `$VAR` is never expanded, so values need no escaping. A direct
  `pnpm tauri build` or `cargo` run doesn't read `.env.local` this way.
- Vite's other `.env` files configure only the frontend.
- An invalid value fails the build, with an error that never echoes it.
- Restart the dev server after changing an input.

## Inputs

| Input | What it sets |
| --- | --- |
| `BUZZ_DEFAULT_COMMUNITY_URL` | A `wss://` or `https://` relay origin selected once on a fresh install. Any saved choice, including Personal space, wins. It also picks a [packaged gateway](#packaged-gateway-descriptors). |
| `BUZZ_EXTERNAL_MCP_COMMUNITIES` | Space-separated community origins where external MCP apps may connect. Empty disables external MCP everywhere. |
| `BUZZ_AGENT_GATEWAY` | An [agent gateway](#agent-gateway) descriptor. |
| `BUZZ_RECOMMENDED_AGENT` | The [recommended agent](#recommended-agent) setup offered as **Automatic**. |
| `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` | [Sign-in servers](#federated-identity-build-input) added to the built-in one. Empty means none. |
| `BUZZ_BUILDERLAB_URL` | Whether the build keeps the built-in Builderlab; see [Builderlab](#builderlab). |
| `BUZZ_BUILDERLAB_APPS_DOMAIN` | The Apps cookie domain for in-app SSO, for Builderlab deployments other than the public one. Empty disables SSO. |
| `BUZZ_BUILDERLAB_APPS_CONTROL_PLANE` | The Apps control plane origin, for deployments the built-in table doesn't list. |
| `BUZZ_BUILD_MANAGED_PLUGINS_URL` | An `https` URL of a version 1 [managed plugin policy](managed-plugins.md#packaged-policy), used when no `managed-plugins.json` exists. |
| `BUZZ_BUILD_REPOSITORY_ACCESS` | Default [repository access rules](repository-access.md#default-rules). |
| `BUZZ_DATABRICKS_HOST` | An `https://` Databricks workspace URL passed to every bundled goose as `DATABRICKS_HOST`. Only the host; model and sign-in stay goose's. |
| `BUZZ_MOBILE_APP_IOS_URL`, `BUZZ_MOBILE_APP_ANDROID_URL` | Store links shown with QR codes on the mobile Settings card, for people whose Builderlab account holds this device's backed-up key. |
| `BUZZ_UPDATER_PUBLIC_KEY`, `BUZZ_UPDATER_ENDPOINT` | Release builds only. Both together turn on the updater; the release workflow sets them (see [releases](releases.md)). |

**Development only:** `BUZZ_RELAY_URL`, `BUZZ_DEV_VIEWER`,
`BUZZ_COMMUNITY_ALIASES`, `BUZZ_DEV_NOTIFICATIONS`, `BUZZ_DEV_OPEN_RELAY`,
`BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` (see [CONTRIBUTING](../CONTRIBUTING.md)),
and [`BUZZ_DEV_FIRST_RUN_ACCOUNT`](#first-run-account-seed-development).

`BUZZ_BUILD_AGENT_ENV`, `BUZZ_BUILD_BUZZ_AGENT_PROVIDER`,
`BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY` and `BUZZ_OWNER_MCP_COMMUNITIES` are no
longer read. Remove them.

## Agent gateway

A gateway sits between local agents and their model providers, so an
organization can route and attribute inference for its communities. The
descriptor is public routing data, version 2:

```json
{
  "version": 2,
  "gateway": "https://gateway.example",
  "communities": [{ "id": "<NIP-11 community UUID>", "origin": "wss://relay.example" }],
  "access_path": "/v9/access",
  "launcher_client": "client-a",
  "headers": {
    "launcher_client": "x-gw-launcher-client",
    "launcher_session": "x-gw-launcher-session",
    "human_pubkey": "x-gw-ctx-human-pubkey",
    "agent_pubkey": "x-gw-ctx-agent-pubkey",
    "community_id": "x-gw-ctx-community-id",
    "channel_id": "x-gw-ctx-channel-id",
    "message_id": "x-gw-ctx-message-id",
    "thread_id": "x-gw-ctx-thread-id"
  },
  "reserved_prefixes": ["x-gw-ctx-"],
  "upstreams": { "pi": { "base": "/upstream/pi" } }
}
```

- `gateway`: an `https://` origin with no path.
- `communities`: 1 to 16 communities, each a NIP-11 community UUID and relay
  origin.
- `access_path`: the gateway's access check.
- `launcher_client`: optional, defaults to `"buzz"`.
- `headers`: a lowercase header name for each context field. Buzz strips any
  incoming header matching these names or `reserved_prefixes` (up to 4) before
  adding its own.
- `upstreams`: a base path per harness (`claude-code`, `goose`, `codex`, `pi`).
  A harness without one keeps the user's own setup.

The shared validation cases are in
`src/features/agents/gateway/descriptor-vectors.json`, and the request
contract is in `src/features/agents/gateway/`.

**When a turn uses it.** An agent's turn goes through the gateway only when its
community's NIP-11 ID is listed, its harness has an upstream, and the access
check succeeds and lists that harness. A bundled plugin can supply the harness
list instead with `ctx.agents.gatewayHarnesses(source)`.

**When it can't.**
- While an access check is pending, a turn waits up to 5 seconds, then fails
  and asks the user to try again.
- A 401 or 403, from the check or from inference, fails the turn and asks the
  user to sign in again. It never falls back, and it holds until a check
  succeeds or the identity, community or relay session changes.
- Any other failure (network, gateway error) runs the turn on the user's own
  setup with no Buzz context, and notes "Ran without the agent gateway".
- Claude Code and Codex use attribution mode: they never wait or fail on the
  gateway, and a blocked route runs unattributed with a note.
- A descriptor that is invalid at runtime turns the gateway off silently.

**Security.** Goose strips `Authorization` before sending to the gateway. The
gateway must authenticate callers itself; the context headers are attribution,
not authentication. Goose can't use the gateway in Community session scope.

**Codex** uses its own configured provider. Buzz adds context when that
provider's `base_url` is on the gateway's origin.

### Packaged gateway descriptors

Instead of setting `BUZZ_AGENT_GATEWAY`, an organization's build can list up to
8 descriptors in `src/bundled/org-gateways.json` (`[]` in open source), for
example one for production and one for staging. When `BUZZ_AGENT_GATEWAY` is
blank, the build uses the entry whose `communities` include
`BUZZ_DEFAULT_COMMUNITY_URL`. A `ws://` relay never matches, and an explicit
`BUZZ_AGENT_GATEWAY` overrides the file.

## Recommended agent

This offers new agents an **Automatic** AI setup: a ranked list of harness,
model and thinking level, from which Buzz picks the first one ready on this
computer.

```sh
BUZZ_RECOMMENDED_AGENT='{"recommendedBy":"Example Co","candidates":[{"harness":"goose","provider":"example","model":"model-b","effort":"high","label":"Model B"},{"harness":"codex","model":"model-a","effort":"high","label":"Model A"},{"harness":"claude-code","model":"model-c","effort":"high","label":"Model C"}]}' bin/pnpm tauri build
```

- `candidates`: best first. Each has `harness` (`goose`, `codex` or
  `claude-code`), `model`, `effort`, `label` (the model's display name) and, for
  goose, `provider`. A plain array of candidates also works.
- `recommendedBy` and `description`: optional text shown with Automatic.

Unset, the create form has no Automatic option.

**How it behaves:**
- A candidate is ready when its harness is installed and signed in and lists
  the model. Each check gets 8 seconds. Codex and Claude Code aren't offered on
  Windows.
- An agent on Automatic saves only `preset: "recommended"`. Changing its model,
  provider or thinking level anywhere takes it off Automatic.
- Once per launch, Buzz moves an Automatic agent to the first ready
  candidate's harness, so an agent whose harness is signed out moves to the next
  one. It moves only on definite answers, never on a timeout, and never while
  it's working or syncing. Its old sessions end and new ones start on the new
  harness.
- If no candidate's model is offered at run time, the agent runs on its
  harness's default instead of failing.
- On a config channel the mark syncs as `"preset": "recommended"` beside
  `settings` in the agent's settings revision (kind 45010), with a matching
  `["preset", "recommended"]` tag. Older versions keep it when they edit.

A bundled plugin can replace the setup per launch with
`ctx.agents.recommend(source)`, for example per team. Buzz waits up to five
seconds for it, then falls back to `BUZZ_RECOMMENDED_AGENT`, so set both.

A bundled plugin can also add **model routes**, such as "Auto Balanced", to the
Claude Code, Codex and Goose Model menus with `ctx.agents.registerModelRouter(router)`.
An agent on a route runs with `route:<id>` as its model, but no copy of its
settings stores that. Its synced settings revision keeps the route beside
`settings`, as `"modelRoute": "<id>"`, with an empty `model`, and its saved
record keeps it beside `config` the same way. A catalog share keeps it as
`model_route` and an exported snapshot as `modelRoute`, with no `model`. Older
versions run the harness's default. A model saved by an older version takes
the agent off the route. Before each turn it starts
while idle in a conversation, Buzz asks `router.select` for one of the
harness's models and a thinking level. A turn that steers a running one keeps
its pick, and a failure or no answer within 30 seconds uses the route's
fallback. The router can ask for the conversation's earlier messages
(`request.history()`) and for what Buzz already holds about the turn
(`request.context()`): what started it, the agent's instructions, skills and
workspace, attached files, and the conversation's last routed pick with when
that turn ended. Buzz runs no git or GitHub calls for either. The router can
also choose the route new agents and Automatic agents use. See
`src/features/agents/model-routes.ts`.

## Federated identity build input

A build trusts a compiled list of sign-in servers. Each community is matched by
its host to a server, and a community no server covers connects without a
token; a relay never chooses one. Each server keeps its own session.

**Built in:** Builderlab for the public hosted communities.

```json
{
  "version": 1,
  "id": "bb-public",
  "identityOrigin": "https://app.builderlab.xyz",
  "communityHosts": ["*.communities.buzz.xyz", "communities.buzz.xyz"],
  "adapterBase": "https://app.builderlab.xyz/api/goose",
  "apiBasePath": "/api/goose/"
}
```

With the built-in server, a build also trusts each Builderlab customer on
demand: a community at `buzz.{name}.builderlab.xyz` signs in at
`https://{name}.builderlab.xyz/api/goose`, as server `bb-{name}`. A server the
build lists for the same host or id takes precedence.

**Adding servers.** Set `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` to one descriptor
or a list. They come before the built-in server, and the first becomes the
build's Builderlab (used for backup, known communities, hosted communities,
Apps and Decisions). No two servers may share an id or a community host. For
`just desktop`, single-quote the JSON in `.env.local`.

```json
{
  "version": 1,
  "id": "example",
  "identityOrigin": "https://identity.example",
  "communityHosts": ["*.communities.example", "custom.example:8443"],
  "adapterBase": "https://identity.example/nip-fa/",
  "apiBasePath": "/api/goose/",
  "signIn": "at-launch",
  "organization": "Example"
}
```

- `signIn`: `on-demand` (the default) asks only when a protected community
  refuses the user, or from Settings → Identity. `at-launch` signs in before
  the app opens, and again whenever the session ends.
- `organization`: up to 64 characters, used in the sign-in copy.

Changing either keeps saved sessions. The welcome screen's **Sign in with
email** is this sign-in.

Hosted agents follow the selected community: in a community another server
covers, their calls use that server's session.

The development broker (`tauri dev` with `BUZZ_DEV_VIEWER` pinned) compiles no
sign-in servers unless you add some. Packaged builds always keep them.

### Builderlab staging

There's no built-in staging server. To sign in to Builderlab staging, add it
(a native test checks this exact descriptor):

```sh
BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG='{"version":1,"id":"bb-public-staging","identityOrigin":"https://app.builderlabstaging.xyz","communityHosts":["*.communities.public.builderlabstaging.xyz","communities.public.builderlabstaging.xyz"],"adapterBase":"https://app.builderlabstaging.xyz/api/goose","apiBasePath":"/api/goose/"}'
```

Staging then becomes the build's Builderlab, with production after it for the
public communities.

## Builderlab

The build's Builderlab is its first sign-in server. With no server added,
`BUZZ_BUILDERLAB_URL` decides whether it keeps the built-in one: unset or
`https://app.builderlab.xyz` keeps it, and anything else turns Builderlab off.
In live development another origin still works through the broker. Setting it
alongside an added sign-in server fails the build.

The bundled Builderlab plugin has no network access of its own. Native code
forwards only its Builderlab routes, with that server's session. Apps deploys
go to the control plane for the identity origin
(`https://compose-ctrl.builderlab.xyz` for production; others set
`BUZZ_BUILDERLAB_APPS_CONTROL_PLANE`). In-app SSO to Apps also needs
`BUZZ_BUILDERLAB_APPS_DOMAIN` (for example `apps.example.com` for a Builderlab at
`https://login.example.com`); only the public deployment has a default.

## First-run account seed (development)

The first-run flow reads and writes the developer's real Builderlab account
(its bound key, owned communities, saved destinations and backups).
`BUZZ_DEV_FIRST_RUN_ACCOUNT` replaces exactly those calls on a dev server, so
you can test first run without touching your real key's binding:

```sh
# A brand-new account.
BUZZ_DEV_FIRST_RUN_ACCOUNT=unlinked
# A returning user, with owned communities.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","communities":["design.example.com"]}'
# Destinations saved to the account.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"known":["chat.example.com","wss://buzz.example.org:8443"]}'
# Every backup fails as if Builderlab were unreachable.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"backup":"unreachable"}'
# The first backup fails, so Try again succeeds.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"backup":"fail-once"}'
# Start over's unlink fails with this HTTP status.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","unlink":503}'
# Restore from backup is offered, but recovery is unavailable.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","backups":["npub1…"]}'
# Restore recovers this throwaway key.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","backups":["npub1…"],"recovery":"nsec1…"}'
```

Every field is optional. `backup` takes a failure kind from
`src/features/identity/backup-failure.ts`. Use a throwaway key: the value is
plain text in your environment. Builds always define it empty, so packaged apps
never use it.

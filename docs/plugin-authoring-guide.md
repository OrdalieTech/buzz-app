# Writing a Buzz plugin

A plugin is a folder with `manifest.json` and one self-contained ES module, `plugin.js`, that exports `inject` (the service names it needs) and `apply(ctx)`. It runs as ordinary, unsandboxed code inside the Buzz desktop app. `apply` must finish within 10 seconds.

API v1 loads one file from a blob URL: no CSS, no assets and no runtime imports. React comes from `ctx.react`, so use classic `React.createElement`; the automatic JSX runtime and bundler chunks don't work.

**Every specific here is a preview and can change between versions.** The reference is the code: the author types in [`src/plugins/author.ts`](https://github.com/block/buzz-app/blob/main/src/plugins/author.ts) and the bundled plugins in [`src/bundled/`](https://github.com/block/buzz-app/tree/main/src/bundled). [Plugins](https://github.com/block/buzz-app/blob/main/docs/plugins.md) says which parts change least. It describes the latest Buzz, which can have services this app doesn't.

## Workflow

1. Write a small first version as plain JS in a folder in your workspace, with no build step. A bundler is worth it only if it emits a single `plugin.js` with classic JSX and no runtime imports.
2. The owner installs it the first time. Either call `plugin_request` with `action` `install` and the folder's absolute path as `repository`, or ask them to open **Settings → Plugins → Manage plugins**, choose **Add**, then **Browse** under Add from folder. It must be **Browse**: a dragged-in folder is copied, so there's nothing to reload.
3. After that, edit the files and call `plugin_reload` with the manifest id. If the new code fails to start, the running revision comes back. Read its `application` result (`applied`, `saved` or `failed`, with `nextStep`). `plugin_status` shows state, errors and what the plugin registered.
4. Reload refuses a changed `manifest.host` or `id`. The owner applies a host change with the plugin's **Update** in Settings; a new id is a new plugin.
5. Check what the user will see, then refine.

## Minimal template

`manifest.json`
```json
{ "id": "example.hello", "name": "Hello", "apiVersion": 1, "description": "Say hello from a plugin page." }
```

`plugin.js`
```js
export const inject = ["react", "pages"];

export function apply(ctx) {
  const React = ctx.react;
  ctx.pages.register({
    id: "main",
    title: "Hello",
    primary: true, // adds a navigation entry; without it the page is search/deep-link only
    component: function Hello() {
      const [count, setCount] = React.useState(0);
      return React.createElement(
        "section",
        { className: "ui-card", style: { padding: "var(--space-panel-inset)" } },
        React.createElement("h1", null, "Hello"),
        React.createElement("button", { type: "button", onClick: () => setCount(count + 1) }, `Clicked ${count} times`),
      );
    },
  });
}
```

## Contract rules

- **Manifest:** `id`, `name`, `apiVersion` (`1`), and optional `description`, `discovery` and `host`. Unknown keys reject the whole folder.
- **Plugin id:** lowercase letters, digits, `.` and `-`, starting with a letter, at most 80 bytes, no empty segments, no underscores. Bundled plugins' ids are reserved. Updates match on `id`.
- **Contribution ids** (pages, panels, shortcuts and so on) match `/^[a-z0-9][a-z0-9._-]*$/` and are unique within the plugin.
- **No work at module top level.** Do everything in `apply`. Enabled plugins activate even when their page is never opened.
- **Declare every service in `inject`.** `apply` runs only once all are available, so a missing one means it never runs; check `plugin_status` after installing. Optional services (`sidebarSections`, `subjectLift`, `notices`, `pluginInstaller`, `seen`, `ui`, `communityJoin`) aren't listed in `inject`: read them with `ctx.reflect.get("name")`, which returns `undefined` on hosts without them.
- **Own everything you start** with `ctx.effect(() => { start(); return () => stop(); })`. Everything you register through `ctx` is removed when the plugin is disabled or replaced.
- **State:** React state resets on reload. The module is evaluated once per revision per app session. Use the `seen` service to remember a one-time experience.
- **Errors:** an invalid `register` call fails activation, and the error shows in Settings and `plugin_status`. Pages and panels render in error boundaries, but loops and global side effects aren't contained.

## Services

Each line is the main call. Read the types for every field.

| Inject | For | Main call |
| --- | --- | --- |
| `pages` | A page, optionally in navigation | `ctx.pages.register({ id, title, component, primary? })` |
| `panels` | A side panel for a link or target | `ctx.panels.register({ id, title, matches(target), component })` |
| `settingsCards` | A Settings destination | `ctx.settingsCards.register({ id, title, component })`. The host supplies navigation and the column, not a heading. |
| `accountActions` | An account menu entry | `ctx.accountActions.register({ id, title, component })` |
| `sidebarSections` (optional) | A Team sidebar section | `register({ version: 1, id, title, icon, rows, select })` |
| `conversation` | Composer and message UI | `registerAccessory`, `registerMessage`, `registerMessageAction`, `registerLink`, `registerLinkPreview` (a link-preview renderer that needs setup first adds `status()`, `subscribe(listener)` and `settings`, its Settings card id; while `status()` is `"needs-setup"` the host draws a card that opens that Settings card), `registerSendGate`, and host components under `ctx.conversation.ui` (Markdown, DocumentEditor, ImageViewer, MembersDialog, Workspace) |
| `agents` | Agent tools and instructions | `ctx.agents.addTool({ name, description, inputSchema, call })`; `addInstructions({ id, text })`; `wake`; hooks need `host.agentHooks` |
| `shortcuts` | Key bindings | `ctx.shortcuts.register({ id, title, binding, run })` |
| `navigation` | Open a destination | `await ctx.navigation.open({ version: 1, kind: "plugin", pluginId, pageId? })` |
| `notifications` | OS notifications | `ctx.notifications.register({ id, label }).submit({ sourceKey, target, title?, body? })` |
| `decisions` | Typed judgments about text | `await ctx.decisions.decide({ state, questions, community })`. It never rejects. |
| `speech` | Speech to text | `ctx.speech.listen({ community, onText, onPause?, onEnd, onError? })` returns `{ stop, cancel }`; failures arrive on `onError`. To be a provider, `ctx.speech.registerProvider(...)`, below. |
| `browser` | An embedded website (macOS) | `ctx.browser.View` inside a panel |
| `notices` (optional) | A notice on any page, with up to three buttons | `await ctx.reflect.get("notices")?.show({ title, description?, actions? }, { signal? })` resolves with the picked action's `id`, or `undefined` if dismissed or aborted. Proceed only on an allow `id`. Pass a tool call's `client.signal` to ask the owner before it runs. |
| `ui` (optional) | The host's own controls | `Button`, `Input`, `Field`, `Switch`, `Dialog`, and `Menu` (newer hosts: check `ui.Menu`). `Menu` takes `items` (`label`, `onSelect`, `tone: "destructive"`, `disabled`), a `label` or `aria-label`, `icon` and `align`. Fall back to plain elements when missing. |
| `host` | Commands, HTTPS, processes, files | Needs `manifest.host`, below |

Agent tool names match `/^[a-z][a-z0-9_]{0,63}$/` and are unique across plugins; prefix them with your plugin. Changing a tool's name, description or schema restarts some agent sessions. `addInstructions` text is sent on every turn, so keep it short.

In a Solo region, check `ui.headerMenuActions === true` before passing
`headerMenuActions` to `ui.Workspace` or `ui.ChannelGroup`. Each **Actions**
entry has a unique `id`, a `label`, and an `onSelect` callback.
`onSelect` can return a promise. The host reports callback failures in the
heading.

In a Solo channel group, entries follow **View channel details**. An optional
`icon` supplies decorative artwork and `hint` adds short help on focus or hover.
The host rechecks the row’s channel membership before calling `onSelect`.

With `placement: "team-row"`, the channel group uses the native
Team menu and ignores these entries.

Check `ctx.conversation.workspaceSlots?.headerActions === true` when you
render, before passing `headerActions` to `ui.Workspace`. The Channels
workspace renders those controls in the main tab's toolbar, before the
three-dot menu. The flag is absent on an older host or when the active
workspace provider does not declare the slot; keep the controls in your page
then. Use compact icon buttons with an `aria-label` and `title`, and set
`aria-pressed` or `aria-expanded` on a toggle. A plugin that replaces the
workspace with `registerWorkspace(component, { slots })` names the optional
props its component renders.

Check `ctx.conversation.workspaceSlots?.trailing === true` in the same way
before passing `trailing` to `ui.Workspace`. The Channels workspace shows that
content as a card over the
bottom of the channel timeline, in its own scroll layer: scrolling over the
card grows it, then slides it up. Render the whole card at rest too, since
growing scrolls it into view: let `expanded` change labels, not what the card
holds. Keep its controls in view with `position: sticky; bottom: 0` and an
opaque background, and draw its outline with a box shadow rather than a bottom
border.

Check `ctx.conversation.workspaceSlots?.aside === true` before passing `aside`
to `ui.Workspace`. The host places it in a box of `asideWidth` (default 320)
over the history's end edge, left of its scrollbar. Docked, it runs from the
history's top to the reader's bottom, and the history's rows and the composer
keep to the width beside it; when the reader would get too narrow, it floats
over the history instead, above the composer. The box
draws nothing in either mode: draw your own card, let it size to its content,
and scroll inside it when it is taller than the box. Only your content takes
pointer input, so the wheel beside or below it scrolls the history. A popover
escapes over the history only from a portal, as `ui.Menu`'s does.
Drive it from your own header control with `asideOpen` and
`onAsideOpenChange`: docked, it shows by default; floating, it shows only once
opened. The host closes it as it floats, restores the docked state when the
reader widens, and closes the overlay on Escape or a press elsewhere in the
reader, reporting each change. Without that control a floating aside stays
closed. `onAsideFloatingChange` tells you whether it floats, for example to
close it after a pick. Messages under the overlay are not marked read.

For `ctx.agents.ui.Transcript`, give each turn a unique `turnId` that stays the same across reads. Return a new turn when it changes. Leave previously returned turns and their items untouched.

## Speech providers

The host owns speech to text end to end: the microphone, a WebRTC peer
connection with one audio track and an `oai-events` data channel, the
transcript, pauses and the end of a listen. A provider only answers the call.
`ctx.speech.registerProvider({ id, label, description, status, subscribe,
connect, Settings? })` adds it to Settings > Speech to text, and the user
chooses it there. Builderlab is the default; audio never goes to a provider
the user didn't choose.

`connect({ offer, community?, maxSeconds?, timeoutMs }, { signal })` gets the
host's SDP offer and resolves with `{ outcome: "answered", sdp, maxSeconds? }`,
an OpenAI Realtime transcription session's SDP answer, or `{ outcome: "failed",
reason }`. The session must send Realtime transcription events (`…delta`,
`…completed`, `input_audio_buffer.committed`) and leave turn detection off: the
host commits the audio at each pause and at the end. `status()` reports
`ready`, `checking`, `unconfirmed` or `needs-setup`, and `Settings` is its
sign-in or setup UI.

## Migration writes

Check `ctx.relay.snapshot().session.supportsMigrationWrites === true` before
starting an import that needs migration labels. Older hosts omit this property.
The property confirms that the host signs the label. Relay support for throttling
depends on the connected community.

Pass `migration: "example-import"` in `session.channelCreation.create(input)`
and in `session.memberAdditions.add(channelId, pubkey, options)`. The host signs
`["migration", source]` on channel creation (kind 9007) and membership additions
(kind 9000). The source must be a nonempty string. The tag classifies workload.
The normal access checks still apply.

The host batches membership additions by source. A migration batch that fails
delivery stops and reports the error. If a successful batch only adds some of
its members, the host keeps the source on individual additions for the rest.
Both calls report relay migration throttling with an error that starts with
`rate-limited:`. Pause the import before issuing another write when you see it.

## Host access (`manifest.host`)

Declare in `manifest.json` the commands, processes, network origins and files your plugin uses, then add `"host"` to `inject`. The host's own APIs only do what's declared, so this is how they get wired up. It isn't a security boundary: plugin code runs in the app and can reach past it.

```json
{
  "id": "example.status",
  "name": "Status",
  "apiVersion": 1,
  "host": {
    "commands": [{ "id": "status", "program": "git", "args": ["status", "--short"] }],
    "networkOrigins": ["https://api.example.com"],
    "processes": [{ "id": "agent", "program": "example-agent" }],
    "files": true
  }
}
```

- `await ctx.host.runCommand("status", input?)` runs a declared command with no shell and a 5 s deadline. It returns stdout, or `null` on failure. The command's environment has `BUZZ_PLUGIN_ID`, the calling plugin's manifest id. It names a well-behaved plugin, not proof: an unsandboxed plugin can call the host command with another plugin's id.
- `await ctx.host.request({ url, method?, headers?, body? })` calls a declared HTTPS origin and returns `{ status, headers, body }`. Plain `fetch` to other origins is blocked, so use this.
- `await ctx.host.writeClipboardText?.(text)` copies plain text the way Buzz does. It needs no grant; check it exists.
- `ctx.host.spawn?.(id, { args?, onStdout? })` starts a declared process (desktop only).
- `files: true` enables `ctx.host.readFile` and `ctx.host.resolveDirectory`.

Other grants (`mcp`, `managedFiles`, `publicImages`, `publicPages`, `agentHooks`, `agentPromptSections`) are in the types. A host that doesn't know a `host` field refuses the whole manifest.

## UI

- The host supplies the shell, navigation, error boundaries, and the outer surface of panels and Settings. Don't add your own page frame, overlays, global styles or theme. Panels sit in a host card, so render only the body. Pages own their padding and scrolling.
- Use the `ui` controls for buttons, fields, switches, dialogs and action menus. Use `className="ui-card"` for a card, `var(--space-panel-inset)` and `var(--space-2)` for spacing, and inline styles for layout. Plain `h1`–`h3`, `p` and `button` get host styling.
- Use host color tokens (`var(--...)`) so light and dark themes both work. Rely only on the `core` roles in `src/shared/design-system/tokens/registry.ts`; other custom properties, classes and `data-*` attributes are internal.
- Avoid fixed widths; pages can be narrow.
- The legacy `buzz.relay-notes/notes` page uses the host's Notes icon even when installed as an external plugin.
- A canonical plugin page link can open beside a conversation if the named
  plugin registers a matching panel with `addressable: true`. Links fall back
  to the plugin page if the panel does not qualify.
- Call `ctx.panels.useTabTitle(label, icon?, actions?)` inside a panel to set
  its tab title. Optional `{ label, run }` actions appear in its context menu
  while the panel is mounted. Keep the actions array stable across renders.
- For `ctx.agents.ui.Transcript`, set `endedAt` on a finished turn, or supply `outcome` if its end time is unknown. Use `at: 0` for an unknown item timestamp. Omit `completedAt` when a tool's start time is unknown.

## Common mistakes

- Any runtime import, including `react` or `react/jsx-runtime`.
- A service missing from `inject`, or an optional one listed there instead of read with `ctx.reflect.get`.
- Work at module top level, or `ctx.react` used outside `apply`.
- Timers, listeners or subscriptions without `ctx.effect`, so they leak across reloads.
- A bundler emitting several chunks, CSS or assets. Only `plugin.js` loads.
- Expecting `plugin_reload` to apply a `manifest.host` change.
- Invalid ids, or an unknown manifest key.
- Expecting React state to survive a reload, or a dragged-in folder to be reloadable.

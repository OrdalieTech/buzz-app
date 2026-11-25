# Design system

Buzz's shared UI lives here: components in `ui/`, tokens and recipes in
`styles/` (values in `styles/tokens.css`, documented in `tokens/registry.ts`),
and icons in `icons/`. Base UI supplies interaction behavior (focus, keyboard,
positioning, dismissal) and Sonner supplies toasts. Buzz owns the appearance.

Run `bin/just design` to open the viewer, which renders every shared component
and token in both themes.

## Using it

- **Start from a shared component.** Its source and the viewer show its variants
  and states. Don't restyle a shared control from feature CSS; the checks reject
  it.
- **The system is the reference, not a nearby screen.** Some screens predate the
  shared components. When a screen and a component disagree, follow the
  component.
- **Fix gaps in the system.** If a real design needs a state, variant, token or
  icon the system lacks, add it here in the same change, for that use. Don't
  work around it locally, and don't add variants nothing uses.
- **Keep product behavior out.** Shared components own appearance and generic
  interaction; data, navigation and persistence stay with the feature.

## Which component

| You're building | Use |
| --- | --- |
| A pane or full-page destination | `FullPageSurface` with one `PanelHeader` and `PanelHeaderLabel` for the title |
| Pane header actions | Icon-only `IconButton`s with an `aria-label` and `title`, like the channel header; `Menu` for overflow |
| A heading inside content | `Header`; `InlineHeader` for a named group |
| Sidebar or settings navigation | `SidebarNavigation` with `NavigationSection` and `NavigationItem` |
| Settings | `SettingsGroup` with `PreferenceRow`, `SwitchPreferenceRow` or `Select variant="preference"`; `layout="form"` when it needs an explicit Save |
| A modal task | `Dialog`; `AlertDialog` for a confirmation. Put the explanation in `description` and Cancel before the action |
| Actions from a trigger | `Menu`; `tone="danger"` for destructive items |
| A short form or supporting content | `Popover` |
| A form value | `Select`; `Combobox` when it needs search |
| A hint on a control | `Tooltip`, or `title` on `Button`/`IconButton` |
| A preview of an object | `PreviewCard` |
| A settled empty or setup state | `EmptyState` with the next action |
| Content that's loading | `LoadingRegion`: it stays quiet for the first second, so fast loads don't flicker |
| A transient result | The shared Toast |
| A person or agent | `Avatar`; see [Identity shapes](#identity-shapes) |

Use `NavigationSectionHeading` for workspace and channel headings. Its
`overlay` actions can cover the trailing edge of the label on pointer
devices. Keep the disclosure caret before the title so it stays clickable.
Use `in-flow` to keep actions clear of the title and any accessory. Heading
hover or keyboard focus reveals actions in place of passive metadata while
the accessory stays mounted. Keep the Actions menu beside the title on touch.
When there is no room for a separate New task button, keep New task in the
menu.

## Colour structure

| Layer | Example | Used by |
|---|---|---|
| **Palette** | `--purple-9`, `--neutral-4` | Shared token definitions; each hue has authored light and dark steps. |
| **Roles** | `--surface-panel`, `--text-danger`, `--affordance-subtle-hover` | Component recipes and product screens. |
| **Components** | Button, Input, Dialog | Product features that need the same appearance and behavior. |

Roles are named by purpose, emphasis and state: `surface-panel`, `text-subtle`,
`border-danger`, `affordance-prominent-pressed`. Pick a role by its job. If none
fits, add one with both light and dark values. Tailwind's stock palette is
removed, and older names such as `text-tertiary` are aliases kept for existing
callers. Opacity is not how you reach a subtler colour: add the step instead.

## Type

Use complete type roles such as `text-body`, `text-caption` and
`text-message`, from `styles/typography.css`. A role carries size, line height,
tracking and weight together. The checks enforce four rules:

1. No arbitrary text sizes.
2. No uppercase or letter-spacing utilities.
3. No line-height override on a type role.
4. Weights are 400 (reading, labels) and 500 (actions, structure) only.

## Contrast

Text must clear WCAG AA and APCA on every surface its role is used on: Lc 60
for body text, Lc 45 for metadata. Control boundaries need WCAG 3:1. The check
measures every pairing in `tokens.css` in both themes.

## Surface and depth

Elevation reads as less translucency, not as a lighter colour: the higher a
surface sits, the more opaque its glass, with a shadow to separate it. Use the
shared materials in `styles/materials.css` instead of mixing your own.

## Hover timing

Hover content opens only once the pointer rests on its trigger, and keyboard
focus opens it at once. Each hover surface belongs to one bucket in
`ui/hoverIntent.ts` (familiar hint, helpful hint, dock label, preview, hover
control). Components accept a bucket, never a delay; to change a timing, change
the bucket.

## Focus appearance

Keyboard focus is always visible. Shared components draw the ring, shown when
`html[data-keyboard-navigation]` is set, so pointer use doesn't leave rings
behind. Shared text fields replace the ring with a border stroke. Don't add
local focus rings.

## Identity shapes

Humans are circles and agents are squircles: `Avatar shape="circle"` or
`shape="squircle"`, chosen from domain data, never guessed from a name or
picture. Format public-key labels with `src/shared/identity/public-key.ts`; don't
slice keys by hand.

## Icons

Tabler is the only icon family. Import named icons from `icons/index.ts`. If
one is missing, add a named `defineIcon("tabler", …)` export there from its
single Tabler module; no approval is needed. Other icon libraries, and Tabler
imports anywhere else, fail the checks.

## Checks

`bin/pnpm design:check` runs the guards in `scripts/design-system/`. They fail on
raw or stock palette colours, literal colours and opacity-dimmed colours,
custom spacing, fonts and text sizes, the type rules above, failing contrast
pairs, icon imports outside the gateway, and feature CSS that restyles shared
controls. Each guard allows named exceptions with a reason, kept in the guard
itself. Passing checks proves only what they measure, so also look at the
change in both themes and at narrow and wide widths.

# Shortcut counter

Import this folder from desktop Settings → Plugins, then enable **Shortcut counter**.
The prebuilt `plugin.js` has no runtime imports or build step. Requires a host with
`shortcuts` (host-matched API v1 preview, not a cross-version SDK).

Press **⌘⇧G** on Mac / **Ctrl+Shift+G** elsewhere to increment. The same handler
backs the button. The count lasts for the plugin lifetime, not a page mount;
disable/re-enable resets it and disposes/re-registers the binding. The typing
field demonstrates the default editable-target guard. No custom DOM listener,
service instance, or manual unload hook is required.

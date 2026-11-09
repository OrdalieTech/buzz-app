// Self-contained external plugin: runtime services come only from the host.
export const inject = ["react", "pages", "shortcuts"];
export function apply(ctx) {
  const React = ctx.react;
  let count = 0;
  const listeners = new Set();
  const increment = () => {
    count++;
    for (const listener of listeners) listener();
  };
  ctx.shortcuts.register({
    id: "increment",
    title: "Increment shortcut counter",
    binding: { key: "g", mod: true, shift: true },
    // Settings order within the Shortcut counter category.
    order: 10,
    run: increment,
  });
  ctx.pages.register({
    id: "main",
    title: "Shortcut counter",
    primary: true,
    component: function ShortcutCounter() {
      const value = React.useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => count,
      );
      return React.createElement(
        "section",
        null,
        React.createElement("h1", null, "Shortcut counter"),
        React.createElement(
          "p",
          { role: "status" },
          `Shortcut count: ${value}`,
        ),
        React.createElement(
          "button",
          { type: "button", onClick: increment },
          "Increment counter",
        ),
        React.createElement(
          "p",
          null,
          "Press Command+Shift+G (Control+Shift+G on other platforms). Typing fields and modal dialogs are excluded by default. Disable the plugin to remove its shortcut.",
        ),
        React.createElement("input", {
          "aria-label": "Shortcut typing guard",
          placeholder: "Shortcuts do not intercept this editor",
        }),
      );
    },
  });
}

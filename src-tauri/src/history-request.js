// Evaluated only in the trusted main webview by the macOS mouse back/forward
// monitor. Native code binds `historyEvent` to the event name to dispatch. A
// focused browser page takes it first; otherwise it reaches the app on window.
(() => {
  const target =
    typeof browserSessionId === "string"
      ? document.querySelector(
          `[data-browser-session="${CSS.escape(browserSessionId)}"]`,
        )
      : window;
  target?.dispatchEvent(
    new Event(historyEvent, { cancelable: true, bubbles: true }),
  );
})();

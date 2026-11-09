// The macOS window starts hidden so preparation never resizes a visible window.
(() => {
  const native = window.__TAURI_INTERNALS__;
  if (!native || !/Mac/i.test(navigator.platform)) return;
  const show = () => {
    void native.invoke("plugin:window|show", { label: "main" }).catch(() => {});
  };
  try {
    if (
      !localStorage.getItem("buzz-mac-welcome-intro.v1") &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      document.documentElement.dataset.welcomeIntro = "pending";
      // A failed bootstrap must still expose the normal launch/error surface.
      setTimeout(() => {
        if (document.documentElement.dataset.welcomeIntro === "pending") {
          delete document.documentElement.dataset.welcomeIntro;
          show();
        }
      }, 8000);
      return;
    }
  } catch {
    // Without persistence, skip the one-time effect.
  }
  show();
})();

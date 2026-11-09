import "./onboarding-transition.css";
import { flushSync } from "react-dom";

let navigation = 0;

/** Snapshot the outgoing welcome so its bees fade away with the forward push. */
export function onboardingTransition(update: () => void, back = false) {
  if (
    !document.startViewTransition ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  document
    .querySelector("main")
    ?.style.setProperty("view-transition-name", "onboarding");
  document.documentElement.dataset.onboardingDirection = back
    ? "back"
    : "forward";
  const current = ++navigation;
  const transition = document.startViewTransition(() => {
    flushSync(update);
    document
      .querySelector("main")
      ?.style.setProperty("view-transition-name", "onboarding");
  });
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (current !== navigation) return;
      delete document.documentElement.dataset.onboardingDirection;
      document
        .querySelector("main")
        ?.style.removeProperty("view-transition-name");
    });
}

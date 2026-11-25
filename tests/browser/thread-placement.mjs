// Inline is the app's default placement. A journey that checks the tab path,
// or the fullscreen media viewer, seeds a pane before the app first reads it.
// It seeds once, so a choice made during the journey survives reloads.
export const seedThreadPlacement = (target, placement = "side") =>
  target.addInitScript((placement) => {
    const key = "buzz-thread-placement.v1";
    if (!localStorage.getItem(key)) localStorage.setItem(key, placement);
  }, placement);

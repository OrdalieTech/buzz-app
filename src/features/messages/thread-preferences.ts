import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

/** inline opens threads, profiles and link panels as dialogs over the view
 * they were opened from instead of as tabs; main and side open them in a tab
 * in that pane. `placeOpening` is where that choice is made. */
export type ThreadPlacement = "inline" | "main" | "side";
const preferenceKey = "buzz-thread-placement.v1";
const changedEvent = "buzz-thread-placement-changed";
let unsavedPreference: ThreadPlacement | undefined;

/** Device-local default for new openings, never an instruction to move
 * existing tabs. Inline unless the viewer chose a pane; the first inline
 * thread's intro is where they can opt out. */
export function threadPlacementPreference(): ThreadPlacement {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    const saved = localStorage.getItem(preferenceKey);
    return saved === "main" || saved === "side" ? saved : "inline";
  } catch {
    return "inline";
  }
}
/** The pane a new thread tab opens in. Inline is not a pane: a thread that
 * still opens as a tab, as a link does, opens in the side pane. */
export function threadTabPane(): "main" | "side" {
  return threadPlacementPreference() === "main" ? "main" : "side";
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    unsavedPreference = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useThreadPlacementPreference() {
  const placement = useSyncExternalStore(subscribe, threadPlacementPreference);
  // Saving the same active choice changes recovery state, not its placement.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { placement, unsaved };
}
export function setThreadPlacementPreference(value: ThreadPlacement): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Thread placement as a device setting. */
export const threadPlacementSetting: DeviceSetting = {
  key: "conversations.thread_placement",
  description:
    "Where new threads open: inline over the conversation, or in a tab in the side pane or the main pane. Inline also opens profiles and link panels over the view they were opened from.",
  schema: { type: "string", enum: ["side", "main", "inline"] },
  applies:
    "New openings only; open tabs stay where they are, Solo threads always open in the side pane, and under inline calls, canvases and apps still open as tabs.",
  read: () => ({
    value: threadPlacementPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This placement is active, but could not be saved on this device.",
  }),
  write: (value) => setThreadPlacementPreference(value as ThreadPlacement),
};

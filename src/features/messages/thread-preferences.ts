import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

export type ThreadPlacement = "main" | "side";
const preferenceKey = "buzz-thread-placement.v1";
const changedEvent = "buzz-thread-placement-changed";
let unsavedPreference: ThreadPlacement | undefined;

/** Device-local default for new tabs, never an instruction to move existing ones. */
export function threadPlacementPreference(): ThreadPlacement {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "main" ? "main" : "side";
  } catch {
    return "side";
  }
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
  description: "Where new thread tabs open: the side pane or the main pane.",
  schema: { type: "string", enum: ["side", "main"] },
  applies:
    "New thread tabs only; open threads stay where they are, and Solo threads always open in the side pane.",
  read: () => ({
    value: threadPlacementPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This placement is active, but could not be saved on this device.",
  }),
  write: (value) => setThreadPlacementPreference(value as ThreadPlacement),
};

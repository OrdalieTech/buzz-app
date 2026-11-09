import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-message-autocorrect.v1";
const changedEvent = "buzz-message-autocorrect-changed";
let unsavedPreference: boolean | undefined;

/** Device-local opt-in to native spelling correction in the message composer. */
export function messageAutocorrectPreference(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "on";
  } catch {
    return false;
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
export function useMessageAutocorrectPreference() {
  const enabled = useSyncExternalStore(subscribe, messageAutocorrectPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setMessageAutocorrectPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** The composer's spelling-correction opt-in as a device setting. */
export const autocorrectSetting: DeviceSetting = {
  key: "conversations.autocorrect",
  description: "Lets macOS correct misspelled words in messages.",
  schema: { type: "boolean" },
  applies: "Only in the message box on a Mac.",
  read: () => ({
    value: messageAutocorrectPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setMessageAutocorrectPreference(value as boolean),
};

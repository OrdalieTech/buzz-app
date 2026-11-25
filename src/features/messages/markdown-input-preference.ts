import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-message-markdown-as-typed.v1";
const changedEvent = "buzz-message-markdown-as-typed-changed";
let unsavedPreference: boolean | undefined;

/** Device-local opt-out of the message composer's typed Markdown conversion:
 * delimiters and block markers stay literal source until the message is sent. */
export function markdownAsTypedPreference(): boolean {
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
export function useMarkdownAsTypedPreference() {
  const enabled = useSyncExternalStore(subscribe, markdownAsTypedPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setMarkdownAsTypedPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Keeping typed Markdown as literal source in messages, as a device setting. */
export const markdownAsTypedSetting: DeviceSetting = {
  key: "conversations.disable_live_formatting",
  description:
    "Keeps Markdown typed in messages as plain characters until sent, without the formatting toolbar or shortcuts.",
  schema: { type: "boolean" },
  applies:
    "Only typing in the message box; sent messages still render Markdown.",
  read: () => ({
    value: markdownAsTypedPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setMarkdownAsTypedPreference(value as boolean),
};

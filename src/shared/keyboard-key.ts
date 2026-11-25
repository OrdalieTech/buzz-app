/** Characters a caret or function key leaves in the document when the host's
 * native text-input path commits the key as if typed. In the desktop build a
 * Right Arrow press can reach WebKit as a key event whose text is the key's raw
 * keyboard-layout translation, U+001D, rather than AppKit's function-key
 * character U+F703: the arrows translate to U+001C through U+001F, Home and End
 * to U+0001 and U+0004, Page Up and Page Down to U+000B and U+000C. WebKit
 * blanks a key event's text only for the private-use block U+F700 through
 * U+F7FF, so such an event types the control character and never moves the
 * caret. The private-use block is refused as well (NSUpArrowFunctionKey U+F700
 * through NSModeSwitchFunctionKey U+F747). No font has a glyph for any of these
 * and no layout types them as prose; the whole Unicode Control category (C0,
 * DEL and C1) is covered, except the tab, newline and carriage return that
 * typed text legitimately holds. */
const CONTROL_CHARACTERS = /[\p{Cc}\uF700-\uF747]/gu;
/** The control characters typed text holds: tab, newline and carriage return. */
const TYPED_CONTROLS = /[\t\n\r]/u;
/** True when a native text insertion holds only control characters. Text that
 * mixes them with real characters is not control text and passes untouched. */
export function controlCharacterText(text: string | null | undefined) {
  return (
    !!text &&
    !TYPED_CONTROLS.test(text) &&
    !text.replace(CONTROL_CHARACTERS, "")
  );
}
/** Caret keys by physical code and by legacy key code, the two identities WebKit
 * still derives from the hardware key when it reports a layout translation as
 * `key`. Pressing such a key must move the caret, not type the character. */
const CARET_KEYS = new Map<string | number, string>([
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
  [33, "PageUp"],
  [34, "PageDown"],
  [35, "End"],
  [36, "Home"],
  [37, "ArrowLeft"],
  [38, "ArrowUp"],
  [39, "ArrowRight"],
  [40, "ArrowDown"],
]);
/** The key a keydown names, restoring a caret key the host reported as a control
 * character (Right Arrow arrives as U+001D) from its code. */
export function keyboardKey(
  event: Pick<globalThis.KeyboardEvent, "key" | "code" | "keyCode">,
) {
  if (!controlCharacterText(event.key)) return event.key;
  return (
    CARET_KEYS.get(event.code) ?? CARET_KEYS.get(event.keyCode) ?? event.key
  );
}
/** The control character each caret key can be reported as, by that key. */
const CONTROL_KEYS = new Map<string, string>([
  ["\u001c", "ArrowLeft"],
  ["\u001d", "ArrowRight"],
  ["\u001e", "ArrowUp"],
  ["\u001f", "ArrowDown"],
  ["\u0001", "Home"],
  ["\u0004", "End"],
  ["\u000b", "PageUp"],
  ["\u000c", "PageDown"],
]);
/** The key a saved binding names. One captured before capture used
 * `keyboardKey` can hold the control character instead of the caret key. */
export function bindingKey(key: string) {
  return CONTROL_KEYS.get(key) ?? key;
}
/** Command-Left or Command-Right with no other modifier: the line-edge keys
 * that an empty message composer lends to Back and Forward on macOS. */
export function isPlainCommandArrow(
  event: Pick<
    globalThis.KeyboardEvent,
    "key" | "code" | "keyCode" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
    return false;
  const key = keyboardKey(event);
  return key === "ArrowLeft" || key === "ArrowRight";
}

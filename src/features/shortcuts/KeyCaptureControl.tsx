import { useEffect, useId, useRef } from "react";
import { Input } from "../../shared/design-system/ui/Input";
import { keyboardKey } from "../../shared/keyboard-key";
import type { KeyBinding } from "./bindings";
import styles from "./KeyCaptureControl.module.css";

export type CapturedChord = Readonly<{
  binding: KeyBinding;
  /** The Windows/Command key off Apple platforms: the dispatcher never matches it. */
  otherPrimary: boolean;
  /** Physical key, for chords whose `key` varies by layout. */
  code: string;
}>;

const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/**
 * Focused listening control. Its own keydown handler consumes the event before
 * the window dispatcher sees it, so the shortcut being rebound never fires.
 * Escape (whatever else is held) and losing focus cancel; the owner decides
 * whether a chord is accepted.
 */
export function KeyCaptureControl({
  apple,
  label,
  describedBy,
  onCapture,
  onCancel,
}: {
  apple: boolean;
  label: string;
  describedBy?: string | undefined;
  onCapture: (chord: CapturedChord) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const instructionId = useId();
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <div className={styles.listening}>
      <span id={instructionId} className="sr-only">
        Press Escape to cancel, or Tab to leave shortcut capture.
      </span>
      <Input
        controlSize="sm"
        ref={input}
        type="text"
        readOnly
        value="Press a shortcut…"
        aria-label={label}
        aria-describedby={[instructionId, describedBy]
          .filter(Boolean)
          .join(" ")}
        data-state="listening"
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (
            event.key === "Tab" &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            // Preserve native focus traversal, but not a plugin's Tab binding.
            event.stopPropagation();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (MODIFIER_KEYS.has(event.key)) return;
          // Someone pressing Shift+Escape or Command+Escape is backing out, not
          // choosing a binding, so Escape never reaches onCapture.
          if (event.key === "Escape") {
            onCancel();
            return;
          }
          // AltGr can report Control+Alt, but the dispatcher always ignores it.
          if (event.getModifierState("AltGraph")) return;
          const mod = apple ? event.metaKey : event.ctrlKey;
          // Saved under the key the dispatcher matches, not WebKit's control character.
          const key = keyboardKey(event);
          onCapture({
            binding: {
              key: key.length === 1 ? key.toLowerCase() : key,
              ...(mod && { mod }),
              ...(apple && event.ctrlKey && { ctrl: true }),
              ...(event.shiftKey && { shift: true }),
              ...(event.altKey && { alt: true }),
            },
            otherPrimary: !apple && event.metaKey,
            code: event.code,
          });
        }}
      />
    </div>
  );
}

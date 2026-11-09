// FOUNDATION: In-app key matching. Local editors handle events before this layer.
export type KeyBinding = Readonly<{
  key: string;
  /** Command on Apple platforms, Control elsewhere. Other modifiers match exactly. */
  mod?: boolean;
  /** Control beside Command on Apple platforms. Elsewhere Control is `mod`, so this never matches. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}>;
export type Shortcut = Readonly<{
  id: string;
  title: string;
  binding: KeyBinding | readonly KeyBinding[];
  run: () => void | Promise<void>;
  /** Read current state; false makes this registration ineligible. */
  when?: () => boolean;
  allowInEditable?: boolean;
  allowInModal?: boolean;
  /** Also run when the topmost modal is its own navigation visit (Settings, Members). */
  allowInVisit?: boolean;
  /** Held keys are consumed but run only once unless opted in. */
  repeat?: boolean;
  /** Lower values appear first within this owner's Settings category; defaults to zero. */
  order?: number;
}>;

/** What the registries hold: aliases are always a frozen array, never a bare binding. */
export type NormalizedShortcut = Shortcut &
  Readonly<{ binding: readonly KeyBinding[]; order: number }>;

export function normalizeShortcut(shortcut: Shortcut): NormalizedShortcut {
  if (
    !shortcut ||
    typeof shortcut.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(shortcut.id) ||
    typeof shortcut.title !== "string" ||
    !shortcut.title.trim() ||
    typeof shortcut.run !== "function" ||
    (shortcut.when !== undefined && typeof shortcut.when !== "function") ||
    [
      shortcut.allowInEditable,
      shortcut.allowInModal,
      shortcut.allowInVisit,
      shortcut.repeat,
    ].some((value) => value !== undefined && typeof value !== "boolean") ||
    (shortcut.order !== undefined && typeof shortcut.order !== "number")
  )
    throw new Error("A shortcut needs an id, title, binding and run function");
  const bindings = Array.isArray(shortcut.binding)
    ? shortcut.binding
    : [shortcut.binding];
  if (!bindings.length || !bindings.every(isKeyBinding))
    throw new Error("Invalid shortcut binding");
  return Object.freeze({
    ...shortcut,
    order: Number.isFinite(shortcut.order) ? (shortcut.order ?? 0) : 0,
    binding: Object.freeze(
      bindings.map((binding) => Object.freeze({ ...binding })),
    ),
  });
}

/** Shape check shared by registration and stored user overrides. */
export function isKeyBinding(value: unknown): value is KeyBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.key === "string" &&
    binding.key.length > 0 &&
    [binding.mod, binding.ctrl, binding.shift, binding.alt].every(
      (flag) => flag === undefined || typeof flag === "boolean",
    )
  );
}

/** Same chord under the dispatcher's rules: case-insensitive key, exact modifiers. */
export function sameBinding(a: KeyBinding, b: KeyBinding) {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.mod === !!b.mod &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt
  );
}

/** Nonempty list of well-formed bindings: the shape stored overrides must take. */
export function isBindingList(value: unknown): value is readonly KeyBinding[] {
  return Array.isArray(value) && value.length > 0 && value.every(isKeyBinding);
}

/** Callers pass the registered alias array or a stored override; nothing is wrapped here. */
export function matches(
  bindings: readonly KeyBinding[],
  event: KeyboardEvent,
  apple: boolean,
) {
  return bindings.some(
    (binding) =>
      binding.key.toLowerCase() === event.key.toLowerCase() &&
      !!binding.mod === (apple ? event.metaKey : event.ctrlKey) &&
      (apple
        ? !!binding.ctrl === event.ctrlKey
        : !binding.ctrl && !event.metaKey) &&
      !!binding.shift === event.shiftKey &&
      !!binding.alt === event.altKey,
  );
}

export function inEditable(event: KeyboardEvent) {
  // composedPath includes the actual input inside an open Shadow DOM, unlike target.
  return event.composedPath().some((target) => {
    const element = target as HTMLElement;
    return (
      element.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
      element.getAttribute?.("role") === "textbox"
    );
  });
}

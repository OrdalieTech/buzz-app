import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/** One view's composer dock, as the rows above it see it: the slot its form
 * sits in, which a sheet opened from a row is drawn inside, around it. */
export type ComposerHandle = Readonly<{
  /** The mounted dock, or null while none is shown. */
  dock(): HTMLElement | null;
  /** Mounts `dock` as this view's composer dock; returns its release. */
  attach(dock: HTMLElement): () => void;
  /** Whether the view will show a composer that isn't there yet, such as a
   * thread's reply box while its root reads. */
  expected(): boolean;
  /** The view says whether its composer is on its way. */
  expect(expected: boolean): void;
  subscribe(listener: () => void): () => void;
}>;
/** `expected` is what the handle assumes until its view says otherwise. */
export function createComposerHandle(expected = false): ComposerHandle {
  let current: HTMLElement | null = null;
  let coming = expected;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    dock: () => current,
    attach: (dock) => {
      current = dock;
      changed();
      return () => {
        if (current !== dock) return;
        current = null;
        changed();
      };
    },
    expected: () => coming,
    expect: (next) => {
      if (next === coming) return;
      coming = next;
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The view rows read in, with its composer: a conversation, or one of its
 * threads (inline or in a tab), named by its root. */
export type ComposerView = Readonly<{
  handle: ComposerHandle;
  rootId?: string | undefined;
  /** False while the view is a hidden tab: its dialogs stay closed. */
  shown: boolean;
  /** A view the address never names, such as a media viewer's comments: its
   * details open in place. */
  local?: boolean | undefined;
}>;
const ComposerScope = createContext<ComposerView | undefined>(undefined);
export const useComposerScope = () => useContext(ComposerScope);

/** Starts a view: rows and the composer below it share its handle. */
export function ComposerScopeProvider({
  rootId,
  shown = true,
  local,
  children,
}: {
  rootId?: string | undefined;
  shown?: boolean | undefined;
  local?: boolean | undefined;
  children: ReactNode;
}) {
  // A thread's reply box comes with its root, unless its thread says it won't.
  const [handle] = useState(() => createComposerHandle(rootId !== undefined));
  const value = useMemo(
    () => ({ handle, rootId, shown, local }),
    [handle, rootId, shown, local],
  );
  return createElement(ComposerScope.Provider, { value }, children);
}

/** A view's composer on screen: its dock, which a sheet is drawn inside and
 * placed around, and the form the dock holds. */
export type ComposerOverlayHost = Readonly<{
  dock: HTMLElement;
  composer: HTMLElement;
}>;

/** `handle`'s composer, while it is on screen. */
export function composerHost(
  handle: ComposerHandle | undefined,
): ComposerOverlayHost | null {
  const dock = handle?.dock();
  if (!dock?.isConnected || !dock.getClientRects().length) return null;
  const composer = dock.querySelector<HTMLElement>(
    ":scope > [data-message-composer]",
  );
  return composer ? { dock, composer } : null;
}

const noSubscription = () => () => {};
/** Changes as `handle`'s composer dock mounts and leaves. */
export function useComposerDock(handle: ComposerHandle | undefined) {
  return useSyncExternalStore(
    handle?.subscribe ?? noSubscription,
    () => handle?.dock() ?? null,
    () => handle?.dock() ?? null,
  );
}

/** Whether `handle`'s view will show a composer that isn't there yet. */
export function useComposerExpected(handle: ComposerHandle | undefined) {
  return useSyncExternalStore(
    handle?.subscribe ?? noSubscription,
    () => handle?.expected() ?? false,
    () => handle?.expected() ?? false,
  );
}

/** `handle`'s composer while it is on screen, following its dock as it mounts,
 * leaves, and gains or loses its box. */
export function useComposerHost(handle: ComposerHandle | undefined) {
  const dock = useComposerDock(handle);
  const host = dock ? composerHost(handle) : null;
  const drawn = useRef(!!host);
  drawn.current = !!host;
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    if (!dock || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!!composerHost(handle) !== drawn.current) redraw();
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, [dock, handle]);
  return host;
}

/** Mounts the element as its view's composer dock. */
export function useComposerDockRef() {
  const handle = useComposerScope()?.handle;
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      return handle?.attach(element);
    },
    [handle],
  );
}

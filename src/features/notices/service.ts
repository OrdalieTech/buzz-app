import { Service, type Context } from "@deepseek-ai/cordis";

export type NoticeAction = Readonly<{
  id: string;
  label: string;
  prominent?: boolean;
}>;
export type NoticeContent = Readonly<{
  title: string;
  description?: string;
  /** At most three buttons. Picking one closes the notice. */
  actions?: readonly NoticeAction[];
}>;
export type Notices = Readonly<{
  /** Shows a notice until it closes, then resolves with the id of the action
   * the person picked, or `undefined` when they dismissed it, `signal`
   * aborted or the plugin's scope ended. */
  show(
    content: NoticeContent,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<string | undefined>;
}>;
/** A notice as the host renders it. `plugin` is the id of the plugin that
 * shows it. */
export type ShownNotice = NoticeContent &
  Readonly<{
    key: string;
    plugin: string;
    pick(action: string): void;
    dismiss(): void;
  }>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("notices")` for old-host compatibility. */
    notices?: Notices;
  }
}

const text = (value: unknown) => typeof value === "string" && !!value.trim();
function checked(content: NoticeContent) {
  const actions = content?.actions ?? [];
  if (
    !text(content?.title) ||
    (content.description !== undefined &&
      typeof content.description !== "string") ||
    !Array.isArray(actions) ||
    actions.length > 3 ||
    !actions.every((action) => text(action?.id) && text(action?.label)) ||
    new Set(actions.map((action) => action.id)).size !== actions.length
  )
    throw new Error(
      "A notice needs a title and at most three actions, each with its own id and a label",
    );
  return {
    title: content.title,
    ...(content.description ? { description: content.description } : {}),
    actions: actions.map(({ id, label, prominent }) => ({
      id,
      label,
      ...(prominent ? { prominent: true } : {}),
    })),
  };
}

export class NoticesService extends Service implements Notices {
  private entries: readonly ShownNotice[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(ctx: Context) {
    super(ctx, "notices");
  }
  snapshot = () => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(entries: readonly ShownNotice[]) {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }

  async show(
    content: NoticeContent,
    { signal }: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ) {
    const ctx = this.ctx;
    const owner = ctx.pluginOwner;
    if (!owner) throw new Error("Notices must be shown by an installed plugin");
    const value = checked(content);
    if (signal?.aborted) return undefined;
    const key = `${owner.id}/${crypto.randomUUID()}`;
    return new Promise<string | undefined>((resolve) => {
      let shown = true;
      const settle = (outcome: string | undefined) => {
        if (!shown) return false;
        shown = false;
        signal?.removeEventListener("abort", dismiss);
        this.publish(this.entries.filter((item) => item !== entry));
        resolve(outcome);
        return true;
      };
      const ended = ctx.effect(() => () => void settle(undefined), key);
      const close = (outcome: string | undefined) => {
        if (settle(outcome)) void ended();
      };
      const dismiss = () => close(undefined);
      const entry: ShownNotice = Object.freeze({
        ...value,
        key,
        plugin: owner.id,
        pick: (action: string) => {
          if (value.actions?.some((item) => item.id === action)) close(action);
        },
        dismiss,
      });
      signal?.addEventListener("abort", dismiss, { once: true });
      this.publish([...this.entries, entry]);
    });
  }
}

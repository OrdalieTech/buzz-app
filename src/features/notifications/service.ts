import { createUnreadIndicator } from "./indicator";
import { Service, type Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import { parseOpenTarget, type OpenTarget } from "../navigation/targets";
import type { Navigation } from "../navigation/controller";
import {
  createNotificationPreferences,
  type NotificationPreferences,
} from "./preferences";
import {
  createNotifications,
  type NotificationPlatform,
  type NotificationPermissionState,
} from "./platform";
import { afterPresentation } from "./presentation";
import {
  playNotificationSound,
  resolveCategorySound,
  type SoundName,
} from "./sound";
import { pluginNotificationText, type NotificationText } from "./content";

export type NotificationCategoryDescriptor = Readonly<{
  id: string;
  label: string;
}>;
export type NotificationEligibility = boolean | "wait";
export type NotificationInput = Readonly<{
  sourceKey: string;
  target: OpenTarget;
  /** Optional display text; the host flattens and bounds it before the OS sees it. */
  title?: string;
  body?: string;
  /** Asked again at each host re-check until delivery, as for built-in
   * alerts: false (or a throw) drops the alert, "wait" holds it. */
  eligible?: () => NotificationEligibility;
}>;
/** Narrows which targets may alert: banners, sounds and the Dock unread dot. */
export type NotificationGate = Readonly<{
  id: string;
  /** A throwing gate is skipped. */
  allows(target: OpenTarget): boolean;
}>;
export interface Notifications {
  register(
    category: NotificationCategoryDescriptor,
  ): Readonly<{ submit(input: NotificationInput): Promise<boolean> }>;
  /** While registered, only targets every gate allows may alert. Returns a
   * remover; disabling the plugin removes it too. */
  gate(gate: NotificationGate): () => void;
  /** The owner's Notify while viewing choice, for an `eligible` check about
   * a conversation the owner may have on screen. Changing it re-asks. */
  notifyWhileViewing(): boolean;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    notifications: Notifications;
  }
}
type Candidate = {
  category: string;
  target: OpenTarget;
  viewer: string;
  expires: number;
  cancelled: boolean;
  submitting: boolean;
  valid(): boolean;
  eligible(): NotificationEligibility;
  text(): NotificationText;
};
const categories = Object.freeze([
  { key: "mention", label: "Mentions" },
  { key: "direct", label: "Direct messages" },
  { key: "thread", label: "Thread replies" },
  { key: "agent", label: "Solo chat completions" },
]);
const FRESH_MS = 120_000;
export type NotificationSnapshot = Readonly<{
  viewer: string | undefined;
  preferences: NotificationPreferences;
  categories: readonly Readonly<{ key: string; label: string }>[];
  permission: NotificationPermissionState;
  requesting: boolean;
  error: string | null;
  preferencesError: string | null;
  platform: string;
  systemManaged: boolean;
  developmentPaused: boolean;
}>;

/** Running-session delivery only: no notification journal, inbox, or recovery protocol. */
export class NotificationsService extends Service implements Notifications {
  readonly indicator = createUnreadIndicator();
  private readonly contributions;
  private readonly gates;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Candidate>();
  // Outstanding audio decisions for submissions awaiting platform acceptance.
  // Revalidation cancels them stickily; cancellation never affects the banner.
  private readonly sounding = new Set<{
    item: Candidate;
    cancelled: boolean;
  }>();
  private readonly seen = new Map<string, number>();
  private closed = false;
  private readonly lifetime = new AbortController();
  private generation = 0;
  private permissionGeneration = 0;
  private permissionRequest: Promise<void> | undefined;
  private entered = false;
  private askedAutomatically = false;
  private scheduled = false;
  private state: NotificationSnapshot;
  constructor(
    ctx: Context,
    private readonly navigation: Navigation,
    private readonly platform: NotificationPlatform = createNotifications(),
    private readonly preferences = createNotificationPreferences(),
    private readonly authorized: (target: OpenTarget) => boolean = (target) =>
      !("scope" in target && target.scope),
    private readonly playSound: (name: SoundName) => void = (name) =>
      void playNotificationSound(name),
    private readonly present: () => boolean = () =>
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      document.hasFocus(),
  ) {
    super(ctx, "notifications");
    this.contributions =
      createContributions<NotificationCategoryDescriptor>(ctx);
    this.gates = createContributions<NotificationGate>(ctx);
    this.state = Object.freeze({
      viewer: undefined,
      ...preferences.snapshot(),
      preferencesError: preferences.snapshot().error,
      categories,
      permission: "default",
      requesting: false,
      platform: platform.label,
      systemManaged: platform.systemManaged ?? false,
      developmentPaused: import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED === "1",
    });
    ctx.effect(() => {
      const stopPreferences = preferences.subscribe(() => {
        const { preferences: value, error } = preferences.snapshot();
        this.publish({ preferences: value, preferencesError: error });
        this.revalidate();
      });
      const stopCategories = this.contributions.subscribe(() => {
        this.publish({
          categories: [
            ...categories,
            ...this.contributions
              .snapshot()
              .map(({ key, label }) => ({ key, label })),
          ],
        });
        this.revalidate();
      });
      const stopGates = this.gates.subscribe(() => this.revalidate());
      const refresh = () => {
        void this.refreshPermission();
      };
      if (typeof window !== "undefined")
        window.addEventListener("focus", refresh);
      return () => {
        this.closed = true;
        this.lifetime.abort();
        this.generation++;
        this.permissionGeneration++;
        for (const item of this.pending) item.cancelled = true;
        this.pending.clear();
        this.seen.clear();
        stopPreferences();
        stopCategories();
        stopGates();
        preferences.dispose();
        platform.dispose();
        this.listeners.clear();
        if (typeof window !== "undefined")
          window.removeEventListener("focus", refresh);
        return this.indicator.dispose();
      };
    });
    void this.refreshPermission();
  }
  snapshot = () => this.state;
  notifyWhileViewing = () => this.state.preferences.notifyWhileViewing;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<NotificationSnapshot>) {
    if (this.closed) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  reportError = (error: unknown) =>
    this.publish({
      error: error instanceof Error ? error.message : String(error),
    });
  selectViewer(viewer: string | undefined) {
    if (this.closed || this.state.viewer === viewer) return;
    if (viewer !== undefined && !/^[a-f0-9]{64}$/.test(viewer))
      throw new Error("Invalid notification viewer");
    this.generation++;
    for (const item of this.pending) item.cancelled = true;
    this.pending.clear();
    this.seen.clear();
    this.publish({ viewer, error: null });
    this.preferences.selectViewer(viewer);
  }
  updatePreferences(patch: Partial<NotificationPreferences>) {
    return this.preferences.update(patch);
  }
  reloadPreferences() {
    this.preferences.reload();
  }
  /** `ask` is false for a read that no entry or window focus caused, such as
   * the Settings check or the read after a failed request: it publishes the
   * status and never sends the automatic request. */
  async refreshPermission({ ask = true } = {}) {
    if (this.closed || this.permissionRequest) return;
    const generation = ++this.permissionGeneration;
    try {
      const permission = await this.platform.permission();
      if (generation === this.permissionGeneration) {
        this.publish({ permission });
        if (ask && permission === "default") this.requestAutomatically();
        this.schedule();
      }
    } catch (error) {
      if (generation === this.permissionGeneration) this.reportError(error);
    }
  }
  /** Whether the person is in the app with a community right now. Only
   * records that: the one automatic system prompt follows from this read or a
   * later window focus, and from neither once they are no longer there. */
  setEntered(entered: boolean) {
    if (this.entered === entered || !this.platform.requestsAutomatically)
      return;
    this.entered = entered;
    if (entered) void this.refreshPermission();
  }
  /** `quiet` is the automatic request: nobody acted, so an ignored system
   * prompt (a native timeout) is not reported and no shown error is cleared. */
  requestPermission({ quiet = false } = {}) {
    if (this.closed || this.state.developmentPaused) return Promise.resolve();
    if (this.permissionRequest) return this.permissionRequest;
    const generation = ++this.permissionGeneration;
    const report = quiet ? () => {} : this.reportError;
    let failed = false;
    this.publish({ requesting: true, ...(quiet ? {} : { error: null }) });
    // Keep the browser's user gesture: no asynchronous probe before the request.
    try {
      this.permissionRequest = this.platform
        .requestPermission()
        .then((permission) => {
          if (generation === this.permissionGeneration)
            this.publish({ permission });
        })
        .catch((error: unknown) => {
          failed = true;
          report(error);
        })
        .finally(() => {
          this.permissionRequest = undefined;
          // A read sent while the prompt was up says denied whatever the
          // answer. Supersede it, so its alert follows the published status.
          this.permissionGeneration++;
          this.publish({ requesting: false });
          // Allow is answered with Buzz in front, and the Dock dot otherwise
          // re-reads its permission only at the next window focus. A Dock
          // read still in flight was sent while the prompt was up.
          void this.indicator.reread();
          // A request that failed says nothing, and macOS reports the prompt
          // it left unanswered as denied: read what the status is now. Only
          // read: a failure is never followed by a request nobody caused.
          if (failed) void this.refreshPermission({ ask: false });
          // Alerts held for the answer are examined once nothing is in flight.
          this.schedule();
        });
    } catch (error) {
      report(error);
      this.publish({ requesting: false });
    }
    return this.permissionRequest ?? Promise.resolve();
  }
  /** Sends the one automatic system prompt per device. Its caller has a
   * status the OS itself just reported as not yet asked. A person who is not
   * looking, or who has alerts off, is asked at a later window focus. */
  private requestAutomatically() {
    if (
      !this.entered ||
      this.askedAutomatically ||
      this.state.developmentPaused ||
      !this.state.preferences.enabled ||
      !this.present()
    )
      return;
    this.askedAutomatically = true;
    if (this.preferences.claimAutomaticRequest())
      void this.requestPermission({ quiet: true });
  }
  private allowed(item: Candidate) {
    return (
      !this.closed &&
      !this.state.developmentPaused &&
      !item.cancelled &&
      item.viewer === this.state.viewer &&
      item.expires > Date.now() &&
      item.valid() &&
      this.authorized(item.target) &&
      this.state.preferences.enabled &&
      this.state.preferences.categories[item.category] !== false &&
      this.gated(item.target)
    );
  }
  private soundEnabled(category: string) {
    return (
      this.state.preferences.sound &&
      resolveCategorySound(this.state.preferences.sounds, category) !== "silent"
    );
  }
  /** Whether every registered gate lets this target alert. */
  gated(target: OpenTarget) {
    return this.gates.snapshot().every((gate) => {
      try {
        return gate.allows(target);
      } catch {
        return true;
      }
    });
  }
  subscribeGates = (listener: () => void) => this.gates.subscribe(listener);
  gate(gate: NotificationGate) {
    if (
      !gate ||
      typeof gate.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(gate.id) ||
      typeof gate.allows !== "function"
    )
      throw new Error("A notification gate needs an id and allows()");
    return this.gates.register(this.ctx, gate);
  }
  revalidate() {
    for (const item of this.pending) {
      if (!this.allowed(item) || item.eligible() === false) {
        item.cancelled = true;
        this.pending.delete(item);
      }
    }
    // Outstanding audio decisions stay under revalidation until the platform
    // resolves them. Any interval of revoked policy/access/eligibility — or
    // Sound turned off or category set to Silent — cancels audio for good.
    // Restoring the setting before submission resolves must not resurrect it.
    for (const decision of this.sounding) {
      if (
        !this.soundEnabled(decision.item.category) ||
        !this.allowed(decision.item) ||
        decision.item.eligible() === false
      )
        decision.cancelled = true;
    }
    this.schedule();
  }
  register(category: NotificationCategoryDescriptor) {
    if (
      !category ||
      typeof category.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(category.id) ||
      typeof category.label !== "string" ||
      !category.label.trim() ||
      category.label.length > 128
    )
      throw new Error("Invalid notification category");
    if (this.contributions.snapshot().length >= 125)
      throw new Error("Too many notification categories");
    const owner = this.ctx.pluginOwner;
    this.contributions.register(this.ctx, category);
    let disposed = false;
    this.ctx.effect(() => () => {
      disposed = true;
    });
    const entry = () =>
      this.contributions
        .snapshot()
        .find(
          (item) =>
            item.pluginId === owner?.id &&
            item.revision === owner?.revision &&
            item.id === category.id,
        );
    return Object.freeze({
      submit: (input: NotificationInput) => {
        const current = entry();
        if (disposed || !current) return Promise.resolve(false);
        if (
          [input?.title, input?.body].some(
            (value) => value !== undefined && typeof value !== "string",
          )
        )
          return Promise.reject(new Error("Invalid notification text"));
        const eligible = input?.eligible;
        if (eligible !== undefined && typeof eligible !== "function")
          return Promise.reject(new Error("Invalid notification eligibility"));
        const text = pluginNotificationText(input, current.label);
        return this.admit(
          current.key,
          current.label,
          input,
          () => !disposed && entry() === current,
          eligible &&
            (() => {
              try {
                const answer = eligible();
                return answer === true || answer === "wait" ? answer : false;
              } catch {
                return false;
              }
            }),
          () => text,
        );
      },
    });
  }
  /** Session-owned producers supply existing attention/access facts, never new read intent. */
  async admit(
    category: string,
    label: string,
    input: NotificationInput,
    valid: () => boolean,
    eligible: () => NotificationEligibility = () => true,
    text: () => NotificationText = () => ({
      title: "Buzz",
      body: `New ${label.toLowerCase()}`,
    }),
  ) {
    const viewer = this.state.viewer;
    if (this.closed || !viewer || !valid()) return false;
    if (
      !input ||
      typeof input.sourceKey !== "string" ||
      !input.sourceKey.length ||
      input.sourceKey.length > 1024
    )
      throw new Error("Invalid notification source identity");
    const target = parseOpenTarget(input.target);
    if ("scope" in target && target.scope && target.scope.viewer !== viewer)
      return false;
    const scope =
      "scope" in target && target.scope
        ? target.scope.communityOrigin
        : "local";
    const source = categories.some((item) => item.key === category)
      ? "message"
      : category;
    const key = JSON.stringify([scope, source, input.sourceKey]);
    const now = Date.now();
    this.revalidate();
    for (const [id, expires] of this.seen)
      if (expires <= now) this.seen.delete(id);
    if (this.seen.has(key)) return false;
    const item: Candidate = {
      category,
      target,
      viewer,
      valid,
      eligible,
      text,
      expires: now + FRESH_MS,
      cancelled: false,
      submitting: false,
    };
    // Visibility is rechecked after the UI commits; do not race the reading hook.
    if (!this.allowed(item)) return false;
    if (this.pending.size >= 128) {
      this.reportError(new Error("Too many pending notifications"));
      return false;
    }
    this.seen.set(key, now + FRESH_MS);
    while (this.seen.size > 2048) {
      const first = this.seen.keys().next().value;
      if (first) this.seen.delete(first);
    }
    this.pending.add(item);
    this.schedule();
    return true;
  }
  private schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    void afterPresentation(undefined, this.lifetime.signal)
      .then(() => {
        this.scheduled = false;
        for (const item of this.pending)
          if (!item.submitting) void this.deliver(item);
      })
      .catch(this.reportError);
  }
  private async deliver(item: Candidate) {
    if (!this.allowed(item) || item.eligible() === false) {
      this.pending.delete(item);
      return;
    }
    if (item.eligible() === "wait") return;
    item.submitting = true;
    const generation = this.generation;
    try {
      const permissionGeneration = this.permissionGeneration;
      const probed = await this.platform.permission();
      const permission =
        permissionGeneration === this.permissionGeneration
          ? probed
          : this.state.permission;
      if (!this.allowed(item)) {
        this.pending.delete(item);
        return;
      }
      if (permission !== "granted" && permission !== "unknown") {
        // Not yet asked holds the alert for an Allow, and so does a request
        // in flight: macOS reports its unanswered prompt as denied. An alert
        // never asks by itself.
        if (permission !== "default" && !this.permissionRequest)
          this.pending.delete(item);
        return;
      }
      if (item.eligible() !== true) {
        if (item.eligible() === false) this.pending.delete(item);
        return;
      }
      // One attempt. A rejected/unknown OS submission is reported, never retried.
      this.pending.delete(item);
      // The item is out of `pending`, so register its audio decision for
      // sticky cancellation by `revalidate` while the submission is
      // outstanding. Sound off at submission means no decision at all.
      const decision = this.soundEnabled(item.category)
        ? { item, cancelled: false }
        : null;
      if (decision) this.sounding.add(decision);
      try {
        await this.platform.show(
          {
            id: crypto.randomUUID(),
            ...item.text(),
          },
          () => {
            if (this.closed || generation !== this.generation) return;
            // Opening may switch to an already joined community. Navigation
            // owns current membership/channel access; admission's
            // selected-session gate must not turn a still-valid prior
            // notification into a dead click.
            void this.navigation.open(item.target).catch(this.reportError);
          },
          (error) => {
            // Native failure can arrive before `show` resolves. Cancellation is
            // about this submission's audio decision, not whether its account
            // still owns visible error reporting.
            if (decision) decision.cancelled = true;
            if (!this.closed && generation === this.generation)
              this.reportError(error);
          },
        );
      } finally {
        if (decision) this.sounding.delete(decision);
      }
      // Banners are always submitted silent; the selected per-category sound
      // plays here once the platform accepted the presentation — but only if
      // the decision survived: not stickily cancelled by any intervening
      // revocation while the submission was outstanding, same account
      // generation, and still allowed, eligible and Sound-enabled now.
      if (
        decision &&
        !decision.cancelled &&
        generation === this.generation &&
        this.soundEnabled(item.category) &&
        this.allowed(item) &&
        item.eligible() === true
      )
        this.playSound(
          resolveCategorySound(this.state.preferences.sounds, item.category),
        );
    } catch (error) {
      this.pending.delete(item);
      this.reportError(error);
    } finally {
      item.submitting = false;
    }
  }
}

import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../artifact-storage/service";
import { hasEventProof } from "./events";
import type { RelaySession } from "./session";
import {
  reconcileArtifactDelta,
  reconcileArtifactCurrent,
} from "./artifact-reconcile";
import {
  ArtifactIncrementalError,
  ARTIFACT_INCREMENTAL_LIMITS,
} from "./artifact-incremental-reader";
import { transportPartition } from "./partition";
import { RECOVERY_DELAYS_MS } from "./recovery";

const REPAIR_MS = 60_000;
type Group = {
  key: string;
  scope: string;
  entries: Set<OpenArtifactCollection>;
  lifetime: AbortController;
  request(): void;
};

/** The existing session supplies live traffic. Web Locks transfer sync work between windows. */
export function provideArtifactStoreSync(
  ctx: Context,
  storage: ArtifactStorageService,
) {
  const groups = new Map<string, Group>();
  function ensureGroup(
    viewer: string,
    relay: string,
    owner: string,
    name: string,
  ) {
    const scope = transportPartition({ viewer, scope: relay, relayAuthor: "" });
    const key = JSON.stringify([viewer, relay, owner, name]);
    let group = groups.get(key);
    if (!group) {
      const lifetime = new AbortController();
      group = { key, scope, entries: new Set(), lifetime, request: () => {} };
      groups.set(key, group);
      const owned = group;
      if (typeof navigator !== "undefined" && navigator.locks) {
        void navigator.locks
          .request(
            `buzz-artifact-sync:${key}`,
            { mode: "exclusive", signal: lifetime.signal },
            () => own(owned, viewer, relay),
          )
          .catch((error) => {
            if (!lifetime.signal.aborted)
              console.error("Artifact sync ownership fails", error);
          });
      }
    }
    return group;
  }
  const stopOpen = storage.onOpen((entry) => {
    const group = ensureGroup(
      entry.viewer,
      entry.relay,
      entry.owner,
      entry.definition.name,
    );
    group.entries.add(entry);
    group.request();
    entry.signal.addEventListener(
      "abort",
      () => {
        group.entries.delete(entry);
        if (!group.entries.size) {
          group.lifetime.abort();
          if (groups.get(group.key) === group) groups.delete(group.key);
        }
      },
      { once: true },
    );
  });
  const refreshScope = () => {
    const { viewer, origin } = ctx.relay.snapshot();
    const scope =
      viewer && origin
        ? transportPartition({ viewer, scope: origin, relayAuthor: "" })
        : undefined;
    if (scope === undefined) return;
    for (const [key, group] of groups)
      if (group.scope !== scope) {
        group.lifetime.abort();
        groups.delete(key);
      }
  };
  const stopScope = ctx.relay.subscribe(refreshScope);
  refreshScope();
  async function own(group: Group, viewer: string, relay: string) {
    let session: RelaySession | undefined;
    let stopSession = () => {};
    let stopLive = () => {};
    let stopWrites = () => {};
    let connected = false;
    let running: Promise<void> | undefined;
    let requested = true;
    const dirty = new Set<string>();
    let retry = 0;
    let notBefore = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let batch: AbortController | undefined;
    const active = () => {
      const now = ctx.relay.snapshot();
      return (
        now.viewer === viewer &&
        now.origin === relay &&
        now.status === "ready" &&
        !now.cached &&
        now.session.live.snapshot().status === "connected"
      );
    };
    const request = () => {
      requested = true;
      pump();
    };
    const hint = (event: import("./events").EventData) => {
      if (
        event.kind === 45010 &&
        [...group.entries].some((entry) =>
          event.tags.some(
            ([key, value]) => key === "type" && value === entry.definition.type,
          ),
        )
      ) {
        const id = event.tags.find(([key]) => key === "d")?.[1];
        if (id && dirty.size < 1000) dirty.add(id);
        else requested = true;
        pump();
      } else if ([45011, 9005, 44100, 44101].includes(event.kind)) request();
    };
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, delay);
    };
    function pump() {
      if (
        running ||
        !group.entries.size ||
        group.lifetime.signal.aborted ||
        !active() ||
        !session?.artifactIncremental ||
        (!requested && !dirty.size)
      )
        return;
      if (Date.now() < notBefore) {
        schedule(notBefore - Date.now());
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      const current = session;
      const reader = current.artifactIncremental;
      if (!reader) return;
      const entry = [...group.entries][0];
      if (!entry || entry.signal.aborted) return;
      batch = new AbortController();
      const signal = AbortSignal.any([
        group.lifetime.signal,
        entry.signal,
        batch.signal,
      ]);
      running = (async () => {
        try {
          if (requested) {
            requested = false;
            try {
              await reconcileArtifactDelta(
                reader,
                entry.collection,
                entry.definition.type,
                signal,
                { reportFailure: retry >= 3 },
              );
            } catch (error) {
              requested = true;
              throw error;
            }
          }
          const ids = [...dirty].slice(
            0,
            ARTIFACT_INCREMENTAL_LIMITS.currentRows,
          );
          if (ids.length) {
            for (const id of ids) dirty.delete(id);
            try {
              await reconcileArtifactCurrent(
                reader,
                entry.collection,
                entry.definition.type,
                ids,
                signal,
                { reportFailure: retry >= 3 },
              );
            } catch (error) {
              for (const id of ids) {
                if (dirty.size < 1000) dirty.add(id);
                else requested = true;
              }
              throw error;
            }
          }
          retry = 0;
          notBefore = 0;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "Artifact collection version changed"
          ) {
            group.entries.delete(entry);
            if (!group.entries.size) {
              group.lifetime.abort();
              if (groups.get(group.key) === group) groups.delete(group.key);
            } else {
              retry = 0;
              requested = true;
            }
          } else if (!signal.aborted) {
            retry++;
            const permanent =
              error instanceof ArtifactIncrementalError &&
              [
                "incremental_limit",
                "incremental_invalid",
                "incremental_unsupported_scope",
              ].includes(error.code);
            const delay =
              !permanent && retry <= 3
                ? (RECOVERY_DELAYS_MS[retry - 1] ?? REPAIR_MS)
                : REPAIR_MS + Math.floor(Math.random() * 30_000);
            notBefore = Date.now() + delay;
            schedule(delay);
          }
        }
      })().finally(() => {
        running = undefined;
        batch = undefined;
        if (!group.lifetime.signal.aborted && (requested || dirty.size)) pump();
      });
    }
    group.request = request;
    const repair = setInterval(request, REPAIR_MS);
    const update = () => {
      const now = ctx.relay.snapshot();
      const next =
        now.viewer === viewer && now.origin === relay ? now.session : undefined;
      const changed = next !== session;
      if (changed) {
        batch?.abort();
        stopSession();
        stopLive();
        stopWrites();
        session = next;
        if (next) {
          stopSession = next.live.subscribe(update);
          stopLive = next.subscribeLive(
            ({ events }) => {
              for (const event of events) if (hasEventProof(event)) hint(event);
            },
            { replay: true },
          );
          stopWrites =
            next.outbox?.observeSend((event) =>
              event.kind === 45010 ? () => hint(event) : undefined,
            ) ?? (() => {});
        }
      }
      const ready = active();
      if (!ready) {
        batch?.abort();
        requested = true;
      } else if (!connected || changed) {
        retry = 0;
        notBefore = 0;
        request();
      }
      connected = ready;
    };
    const stopRelay = ctx.relay.subscribe(update);
    update();
    try {
      await new Promise<void>((resolve) => {
        if (group.lifetime.signal.aborted) resolve();
        else
          group.lifetime.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    } finally {
      batch?.abort();
      clearTimeout(timer);
      clearInterval(repair);
      stopRelay();
      stopSession();
      stopLive();
      stopWrites();
      group.request = () => {};
      await running;
    }
  }
  ctx.effect(() => () => {
    stopOpen();
    stopScope();
    for (const group of groups.values()) group.lifetime.abort();
    groups.clear();
  });
}

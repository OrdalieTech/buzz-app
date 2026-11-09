import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../../src/features/artifact-storage/service";
import { createArtifactStore } from "../../src/features/artifact-storage/store";
import type { HostArtifactCollection } from "../../src/features/artifact-storage/types";
import type { ArtifactIncrementalReader } from "../../src/features/relay/artifact-incremental-reader";
import { provideArtifactStoreSync } from "../../src/features/relay/artifact-store-sync";

const viewer = "a".repeat(64);
const captures: string[] = [];
const collections = new Map<
  string,
  { collection: HostArtifactCollection; controller: AbortController }
>();
let store: ReturnType<typeof createArtifactStore>;
let relay: string;
let opened: (entry: OpenArtifactCollection) => void;
let stop = () => {};
const api = {
  captures,
  open(scope: string) {
    relay = `https://${scope}.test`;
    store = createArtifactStore(viewer, relay);
    const reader: ArtifactIncrementalReader = {
      async delta(query) {
        captures.push(query["#type"][0]?.slice("test.sync.".length) ?? "");
        return {
          startedAt: "2026-10-21T12:00:00.000001Z",
          overlapSeconds: 120,
          changes: [],
          nextCursor: null,
          checkpoint: crypto.randomUUID(),
        };
      },
      async current(_query, artifactIds) {
        return {
          startedAt: "2026-10-21T12:00:00.000002Z",
          changes: artifactIds.map((artifactId) => ({
            type: "remove" as const,
            artifactId,
          })),
        };
      },
    };
    const session = {
      artifactIncremental: reader,
      live: {
        snapshot: () => ({ status: "connected" }),
        subscribe: () => () => {},
      },
      subscribeLive: () => () => {},
    };
    const ctx = {
      relay: {
        snapshot: () => ({
          viewer,
          origin: relay,
          status: "ready",
          cached: false,
          session,
        }),
        subscribe: () => () => {},
      },
      effect: (effect: () => () => void) => {
        stop = effect();
      },
    };
    provideArtifactStoreSync(
      ctx as unknown as Context,
      {
        onOpen: (listener: typeof opened) => {
          opened = listener;
          return () => {};
        },
      } as unknown as ArtifactStorageService,
    );
  },
  async openCollection(name: string) {
    const definition = {
      name,
      type: `test.sync.${name}`,
      version: 1,
      project: () => [],
    };
    const collection = store.collection("test.plugin", definition);
    const controller = new AbortController();
    collections.set(name, { collection, controller });
    await collection.importBatch({
      records: [{ id: "task", local: { title: "Saved" } }],
      preferences: [{ id: "task", value: { pinned: false } }],
      marker: "ready",
    });
    opened({
      viewer,
      relay,
      owner: "test.plugin",
      definition,
      collection,
      signal: controller.signal,
    });
  },
  checkpoint(name: string) {
    const entry = collections.get(name);
    if (!entry) throw new Error("Collection is not open");
    return entry.collection.checkpoint();
  },
  read(name: string) {
    const entry = collections.get(name);
    if (!entry) throw new Error("Collection is not open");
    return entry.collection.get("task");
  },
  close() {
    stop();
    for (const entry of collections.values()) entry.controller.abort();
    store?.close();
  },
};
declare global {
  interface Window {
    artifactSyncTest: typeof api;
  }
}
window.artifactSyncTest = api;
window.addEventListener("pagehide", () => api.close());

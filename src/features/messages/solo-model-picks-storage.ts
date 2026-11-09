import { lockSoloModelPicks } from "./solo-model-picks-lock";

const databaseName = "buzz-solo-model-picks-v1";
const listeners = new Map<string, Set<() => void>>();

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("picks", { keyPath: ["scope", "key"] })
        .createIndex("scope", "scope");
    };
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Close other Buzz windows to open saved choices."));
    };
  });
}

export type ModelPicksTransaction = {
  revision(key: string): string | null;
  version(key: string): string;
  write(key: string, value: unknown): string;
};

/** IDB, not a page's localStorage cache, owns read/merge/compare/write. */
export async function transactModelPicks<T>(
  scope: string,
  keys: readonly string[],
  change: (transaction: ModelPicksTransaction) => T,
) {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("picks", "readwrite", {
        durability: "strict",
      });
      const store = tx.objectStore("picks");
      const revisions = new Map<string, string | null>();
      const versions = new Map<string, string>();
      let result: T;
      let failure: unknown;
      const unique = [...new Set(keys)];
      if (!unique.length) {
        tx.abort();
        reject(new Error("Missing saved-choice coordinates."));
        return;
      }
      for (const key of unique) {
        const request = store.get([scope, key]);
        request.onsuccess = () => {
          try {
            const revision: string | null | undefined =
              request.result === undefined ? null : request.result.revision;
            if (revision === undefined)
              throw new Error("Saved choices are unreadable.");
            const version: string =
              request.result?.version ?? crypto.randomUUID();
            revisions.set(key, revision);
            versions.set(key, version);
            if (request.result === undefined)
              store.put({ scope, key, revision, version });
            if (revisions.size !== unique.length) return;
            result = change({
              revision(key) {
                const revision = revisions.get(key);
                if (revision === undefined)
                  throw new Error("Unread saved-choice coordinate.");
                return revision;
              },
              version(key) {
                const version = versions.get(key);
                if (version === undefined)
                  throw new Error("Unread saved-choice coordinate.");
                return version;
              },
              write(key, value) {
                if (!revisions.has(key))
                  throw new Error("Unread saved-choice coordinate.");
                const revision = value === null ? null : JSON.stringify(value);
                const version = crypto.randomUUID();
                revisions.set(key, revision);
                versions.set(key, version);
                store.put({ scope, key, revision, version });
                return version;
              },
            });
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ?? tx.error ?? new Error("Saved-choice transaction aborted."),
        );
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function subscribeModelPicks(scope: string, listener: () => void) {
  let subscribers = listeners.get(scope);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(scope, subscribers);
  }
  subscribers.add(listener);
  const channel = new BroadcastChannel(`${databaseName}:${scope}`);
  channel.onmessage = listener;
  return () => {
    channel.close();
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(scope);
  };
}

/** Notifications carry no snapshot; readers always reread committed IDB state. */
export function publishModelPicks(scope: string) {
  for (const listener of listeners.get(scope) ?? []) listener();
  const channel = new BroadcastChannel(`${databaseName}:${scope}`);
  channel.postMessage(null);
  channel.close();
}

export async function purgeSoloModelPicks(scope: string) {
  if (typeof indexedDB === "undefined") return;
  return lockSoloModelPicks(scope, async () => {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("picks", "readwrite", {
          durability: "strict",
        });
        const store = tx.objectStore("picks");
        const request = store
          .index("scope")
          .getAllKeys(IDBKeyRange.only(scope));
        request.onsuccess = () => {
          for (const key of request.result) store.delete(key);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(tx.error ?? new Error("Saved-choice purge aborted."));
        tx.onerror = () => reject(tx.error);
      });
      publishModelPicks(scope);
    } finally {
      db.close();
    }
  });
}

import { getPublicKey } from "nostr-tools";

// The key at rest: raw secret bytes sealed with a non-extractable AES-GCM key
// stored beside them (our old PWA's vault format, which v2 keeps). This
// protects against reading the profile's files, not against script on the
// origin, so a strict CSP stays part of custody.

type Sealed = {
  id: string;
  pubkey: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  wrappingKey: CryptoKey;
};
type Vault = { database: string; store: string; id: string };

const current: Vault = {
  database: "buzz-identity-v2",
  store: "human",
  id: "human",
};
/** Our previous PWA's vault on the same origin. Read only, never written. */
const previous: Vault = {
  database: "buzz-desktop-web-vault",
  store: "identity",
  id: "current",
};
export const SAVED = "An identity is already saved; nothing was overwritten";

/** Opens a vault; without `create`, a missing database stays missing. */
function open(vault: Vault, create: boolean) {
  return new Promise<IDBDatabase | undefined>((resolve, reject) => {
    const request = indexedDB.open(vault.database);
    request.onupgradeneeded = () => {
      if (create)
        request.result.createObjectStore(vault.store, { keyPath: "id" });
      else request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      create ? reject(request.error) : resolve(undefined);
  });
}

export async function run<T>(
  vault: Vault,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  create = false,
): Promise<T | undefined> {
  const database = await open(vault, create);
  if (!database?.objectStoreNames.contains(vault.store)) {
    database?.close();
    return undefined;
  }
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(vault.store, mode);
    const request = operation(transaction.objectStore(vault.store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? request.error);
  }).finally(() => database.close());
}

async function unseal(record: Sealed | undefined) {
  if (!record) return null;
  const secret = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv.slice() },
      record.wrappingKey,
      record.ciphertext,
    ),
  );
  if (getPublicKey(secret) !== record.pubkey)
    throw new Error("Saved identity does not match its public key");
  return secret;
}

export const load = () =>
  run<Sealed>(current, "readonly", (store) => store.get(current.id)).then(
    unseal,
  );

/** Create-only: an existing record is never replaced. */
export async function save(secret: Uint8Array) {
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    secret.slice(),
  );
  const record = { id: current.id, v: 2, pubkey: getPublicKey(secret) };
  await run(
    current,
    "readwrite",
    (store) => store.add({ ...record, iv, ciphertext, wrappingKey }),
    true,
  ).catch((error: unknown) => {
    throw error instanceof DOMException && error.name === "ConstraintError"
      ? SAVED
      : error;
  });
}

/** Sign-out removes every copy of the key this origin holds. */
export async function remove() {
  for (const vault of [current, previous])
    await run(vault, "readwrite", (store) => store.delete(vault.id));
}

export const legacyRecord = () =>
  run<Sealed>(previous, "readonly", (store) => store.get(previous.id));

export const loadLegacy = () => legacyRecord().then(unseal);

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { beforeEach, expect, test, vi } from "vitest";
import { derive, ecdh } from "./pairing.ts";

const store = vi.hoisted(() => ({
  saved: undefined as Uint8Array | undefined,
}));
vi.mock("./vault.ts", () => ({
  SAVED: "saved",
  load: async () => store.saved ?? null,
  save: async (secret: Uint8Array) => {
    if (store.saved) throw "saved";
    store.saved = secret;
  },
}));
let run: (command: string, args?: object) => Promise<unknown>;
beforeEach(async () => {
  store.saved = undefined;
  vi.resetModules();
  const { keyCommands } = await import("./keys.ts");
  const { setupCommands } = await import("./key-setup.ts");
  run = async (command, args = {}) =>
    (keyCommands[command] ?? setupCommands[command])?.(args);
});

test("derives NIP-AB's comparison values as crates/pairing does", async () => {
  const source = hexToBytes(
    "7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5",
  );
  const target = hexToBytes(
    "3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b",
  );
  const secret = hexToBytes(
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  );
  const sourcePubkey = getPublicKey(source);
  expect(
    await derive(
      secret,
      sourcePubkey,
      getPublicKey(target),
      ecdh(target, sourcePubkey),
    ),
  ).toEqual({
    id: "fb357d0f8e8d5a5ba3b2a91cb18c119e1567b07ffa38cdebb73e68df78f5a380",
    sas: "863346",
    transcript:
      "d662818ff8911fc60a2d025f8b8b4756107104e85888dd202d28db5ca2cf28d3",
  });
});

test("keeps a created key only when its npub is imported", async () => {
  const npub = (await run("setup_create")) as string;
  expect(store.saved).toBeUndefined();
  await expect(
    run("identity_import", { nsec: npub.slice(0, -1) }),
  ).rejects.toBe("Enter a valid nsec private key");
  expect(await run("identity_import", { nsec: npub })).toBe(
    nip19.decode(npub).data,
  );
  // Create-only: a later key, however it came, never replaces it.
  const next = (await run("setup_create")) as string;
  await expect(run("identity_import", { nsec: next })).rejects.toBe("saved");
  expect(store.saved && nip19.npubEncode(getPublicKey(store.saved))).toBe(npub);
});

test("restores a NIP-49 backup with its password only", async () => {
  const npub = await run("setup_create");
  await expect(run("setup_backup", { password: "short" })).rejects.toMatch(
    "12 characters",
  );
  const password = "correct horse battery";
  const backup = (await run("setup_backup", { password })) as string;
  expect(backup).toMatch(/^ncryptsec1/);
  await run("setup_create");
  await expect(
    run("setup_open", { ncryptsec: backup, password: "wrong password!" }),
  ).rejects.toBe("Wrong password, or the backup is damaged.");
  expect(await run("setup_open", { ncryptsec: backup, password })).toBe(npub);
  // log_n 19 (payload byte 1) is refused before scrypt runs.
  const bech32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const forged = `${backup.slice(0, 13)}${bech32[bech32.indexOf(backup.charAt(13)) | 16]}${backup.slice(14)}`;
  await expect(run("setup_open", { ncryptsec: forged, password })).rejects.toBe(
    "This backup can’t be opened here.",
  );
}, 30_000);

test("refuses codes that are not a desktop's pairing offer", async () => {
  const pubkey = getPublicKey(generateSecretKey());
  const secret = "ab".repeat(32);
  const code = (query: string) => ({ code: `nostrpair://${pubkey}?${query}` });
  await expect(run("setup_pair", { code: "nsec1" })).rejects.toBe(
    "That isn’t a Buzz pairing code.",
  );
  await expect(
    run("setup_pair", code(`secret=${secret}&relay=ws%3A%2F%2Fevil.test&v=1`)),
  ).rejects.toBe("This pairing code uses an insecure relay.");
  await expect(
    run(
      "setup_pair",
      code(`secret=${secret}&relay=wss%3A%2F%2Fr.test&v=1&mode=recover`),
    ),
  ).rejects.toBe("This code asks for an identity instead of sending one.");
});

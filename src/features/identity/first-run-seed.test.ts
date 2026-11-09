import { describe, expect, it, vi } from "vitest";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { BackupError } from "./backup";
import { seededAccount } from "./builderlab-account";
import { parseFirstRunAccountSeed } from "./first-run-seed";
import { type IdentitySnapshot, recoveryOff } from "./service";

const pubkey = "ab".repeat(32);
/** Only a seeded restore imports a key. */
const noImport = {
  importKey: () => Promise.reject(new Error("Imported a key")),
  snapshot: (): IdentitySnapshot => ({ status: "missing", busy: false }),
};

describe("parseFirstRunAccountSeed", () => {
  it("is absent when unset, and `unlinked` answers no key and no communities", async () => {
    expect(parseFirstRunAccountSeed()).toBeUndefined();
    expect(parseFirstRunAccountSeed("  ")).toBeUndefined();
    const seed = parseFirstRunAccountSeed("unlinked");
    expect(seed).toEqual({ linked: null, communities: [] });
    if (!seed) throw new Error("unreachable");
    const account = seededAccount(seed, noImport);
    expect(await account.linkedKey()).toBeNull();
    expect(await account.communityList()).toEqual({
      owned: [],
      canCreate: false,
    });
    expect(await account.knownCommunities()).toEqual([]);
    await expect(account.backUp(pubkey)).resolves.toBeUndefined();
    await expect(account.bind(pubkey)).resolves.toBeUndefined();
    await expect(account.unbind(pubkey, pubkey)).resolves.toBeUndefined();
    expect(await account.backupStatus()).toEqual([]);
  });

  it.each([
    [503, "Builderlab account unlink failed (HTTP 503).", true],
    [403, "Builderlab account unlink failed (HTTP 403).", false],
    [401, "Your Builderlab sign-in is no longer valid.", false],
  ])(
    "fails every unlink as kgoose answering %i would",
    async (status, message, retryable) => {
      const seed = parseFirstRunAccountSeed(
        JSON.stringify({ npub: npubEncode(pubkey), unlink: status }),
      );
      expect(seed).toEqual({ linked: pubkey, communities: [], unlink: status });
      if (!seed) throw new Error("unreachable");
      const failed: unknown = await seededAccount(seed, noImport)
        .unbind(pubkey, pubkey)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toBe(message);
      expect((failed as { retryable?: unknown }).retryable === true).toBe(
        retryable,
      );
    },
  );

  it("fails every backup with a seeded kind, for a linked or an unlinked account", async () => {
    const seed = parseFirstRunAccountSeed('{"backup":"unreachable"}');
    expect(seed).toEqual({
      linked: null,
      communities: [],
      backup: "unreachable",
    });
    if (!seed) throw new Error("unreachable");
    const failed = await seededAccount(seed, noImport)
      .backUp(pubkey)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(BackupError);
    expect(failed).toMatchObject({ kind: "unreachable", retryable: true });
    expect(
      parseFirstRunAccountSeed(
        JSON.stringify({ npub: npubEncode(pubkey), backup: "timeout" }),
      ),
    ).toEqual({ linked: pubkey, communities: [], backup: "timeout" });
    expect(parseFirstRunAccountSeed("{}")).toEqual({
      linked: null,
      communities: [],
    });
  });

  it("fails only the first backup with fail-once, as unconfirmed, for a linked or an unlinked account", async () => {
    for (const value of [
      { backup: "fail-once" },
      { npub: npubEncode(pubkey), backup: "fail-once" },
    ]) {
      const seed = parseFirstRunAccountSeed(JSON.stringify(value));
      expect(seed).toMatchObject({ backup: "fail-once" });
      if (!seed) throw new Error("unreachable");
      const account = seededAccount(seed, noImport);
      const failed = await account
        .backUp(pubkey)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(BackupError);
      expect(failed).toMatchObject({ kind: "unconfirmed", retryable: true });
      await expect(account.backUp(pubkey)).resolves.toBeUndefined();
      // Each sign-in's account fails once again.
      await expect(
        seededAccount(seed, noImport).backUp(pubkey),
      ).rejects.toThrow(BackupError);
    }
  });

  it("decodes the npub to hex and canonicalizes the owned and saved hosts", async () => {
    const seed = parseFirstRunAccountSeed(
      JSON.stringify({
        npub: npubEncode(pubkey),
        communities: ["Design.Example.com", "wss://buzz.example.org:8443"],
        // Saved destinations take the field's spellings and come back as kgoose lists them.
        known: ["Chat.Example.com.", "https://buzz.example.org:8443/"],
      }),
    );
    expect(seed).toEqual({
      linked: pubkey,
      communities: [
        { host: "design.example.com", url: "https://design.example.com" },
        { host: "buzz.example.org:8443", url: "https://buzz.example.org:8443" },
      ],
      known: ["wss://chat.example.com", "wss://buzz.example.org:8443"],
    });
    if (!seed) throw new Error("unreachable");
    const account = seededAccount(seed, noImport);
    expect(await account.linkedKey()).toBe(pubkey);
    expect(await account.knownCommunities()).toEqual([
      "wss://chat.example.com",
      "wss://buzz.example.org:8443",
    ]);
    expect(
      parseFirstRunAccountSeed(JSON.stringify({ npub: npubEncode(pubkey) })),
    ).toEqual({ linked: pubkey, communities: [] });
  });

  it("lists the seeded backups, decoded to hex, in backup status", async () => {
    const other = "cd".repeat(32);
    const seed = parseFirstRunAccountSeed(
      JSON.stringify({
        npub: npubEncode(pubkey),
        backups: [npubEncode(pubkey), npubEncode(other)],
      }),
    );
    expect(seed).toEqual({
      linked: pubkey,
      communities: [],
      backups: [pubkey, other],
    });
    if (!seed) throw new Error("unreachable");
    expect(await seededAccount(seed, noImport).backupStatus()).toEqual([
      pubkey,
      other,
    ]);
  });

  it("answers every restore that recovery is unavailable when no key is seeded, with no native command", async () => {
    const seed = parseFirstRunAccountSeed(
      JSON.stringify({ npub: npubEncode(pubkey) }),
    );
    if (!seed) throw new Error("unreachable");
    const { recovery } = seededAccount(seed, noImport);
    const changed = vi.fn();
    recovery.subscribe(changed);
    expect(recovery.snapshot()).toBeUndefined();
    await recovery.beginRecovery();
    expect(recoveryOff(recovery.snapshot())).toBe(true);
    expect(await recovery.cancelRecovery()).toBe(true);
    expect(recovery.snapshot()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("recovers the seeded key and installs it through the native import", async () => {
    const secret = generateSecretKey();
    const nsec = nsecEncode(secret);
    const restored = getPublicKey(secret);
    const seed = parseFirstRunAccountSeed(
      JSON.stringify({ npub: npubEncode(restored), recovery: nsec }),
    );
    expect(seed).toEqual({
      linked: restored,
      communities: [],
      recovery: { nsec, pubkey: restored },
    });
    if (!seed) throw new Error("unreachable");
    let state: IdentitySnapshot = { status: "missing", busy: false };
    const importKey = vi.fn(async (_nsec: string) => {
      state = { status: "ready", viewer: restored };
    });
    const { recovery } = seededAccount(seed, {
      importKey,
      snapshot: () => state,
    });
    await recovery.beginRecovery();
    expect(recovery.snapshot()).toEqual({
      status: "choosing",
      candidates: [{ handle: "seed", pubkey: restored }],
      currentPubkey: restored,
      failedCount: 0,
    });
    await recovery.installRecovery("seed");
    expect(importKey.mock.calls).toEqual([[nsec]]);
    expect(recovery.snapshot()).toBeUndefined();

    // A refused import is the restore's error, as a native one would be.
    state = { status: "missing", busy: false, error: "Couldn’t save the key." };
    importKey.mockResolvedValueOnce(undefined);
    await recovery.beginRecovery();
    await recovery.installRecovery("seed");
    expect(recovery.snapshot()).toEqual({
      status: "error",
      error: "Couldn’t save the key.",
    });
  });

  it.each([
    ["garbage", "linked"],
    ["an array", "[]"],
    ["a private key", JSON.stringify({ npub: nsecEncode(new Uint8Array(32)) })],
    ["hex instead of an npub", JSON.stringify({ npub: pubkey })],
    [
      "an unknown field",
      JSON.stringify({ npub: npubEncode(pubkey), secret: "s3cret" }),
    ],
    ["an unknown backup kind", JSON.stringify({ backup: "s3cret" })],
    [
      "an inherited name as a backup kind",
      JSON.stringify({ backup: "toString" }),
    ],
    ["a non-string backup kind", JSON.stringify({ backup: true })],
    ["a misspelled fail-once", JSON.stringify({ backup: "fail_once" })],
    ["a backup list that is not a list", JSON.stringify({ backups: "s3cret" })],
    ["a hex backup", JSON.stringify({ backups: [pubkey] })],
    [
      "a private key as a backup",
      JSON.stringify({ backups: [nsecEncode(new Uint8Array(32).fill(1))] }),
    ],
    ["a non-string recovery key", JSON.stringify({ recovery: 1 })],
    [
      "an npub as the recovery key",
      JSON.stringify({ recovery: npubEncode(pubkey) }),
    ],
    ["a malformed recovery key", JSON.stringify({ recovery: "nsec1s3cret" })],
    ["a non-numeric unlink status", JSON.stringify({ unlink: "s3cret" })],
    ["a successful unlink status", JSON.stringify({ unlink: 200 })],
    ["a fractional unlink status", JSON.stringify({ unlink: 503.5 })],
    [
      "a non-string host",
      JSON.stringify({ npub: npubEncode(pubkey), communities: [1] }),
    ],
    [
      "an insecure host",
      JSON.stringify({
        npub: npubEncode(pubkey),
        communities: ["http://s3cret.example"],
      }),
    ],
    ["a non-array known list", JSON.stringify({ known: "s3cret.example" })],
    ["a non-string saved host", JSON.stringify({ known: [1] })],
    [
      "an insecure saved host",
      JSON.stringify({ known: ["http://s3cret.example"] }),
    ],
    [
      "a saved host with a path",
      JSON.stringify({ known: ["wss://s3cret.example/relay"] }),
    ],
  ])("rejects %s without echoing it", (_label, raw) => {
    expect(() => parseFirstRunAccountSeed(raw)).toThrow(
      /^BUZZ_DEV_FIRST_RUN_ACCOUNT must be/,
    );
    expect(() => parseFirstRunAccountSeed(raw)).not.toThrow(/s3cret/);
  });
});

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip49";
import { receive } from "./pairing.ts";

// First-run keys the key Worker holds unsaved: created, opened from a NIP-49
// backup or received by pairing. Nothing here writes the vault: Welcome's
// import saves the held key create-only, named by its npub (keys.ts
// identity_import), so a key is only kept once the user chose to continue.

// biome-ignore lint/suspicious/noExplicitAny: arguments come from the page, checked below.
type Args = Record<string, any>;

/** Our earlier desktop's backup cost (key_backup.rs); also the most we open. */
const BACKUP_LOG_N = 18;
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

let held: Uint8Array | undefined;
let pairing: ReturnType<typeof receive> | undefined;

const npub = (secret: Uint8Array) => nip19.npubEncode(getPublicKey(secret));
function hold(secret: Uint8Array) {
  held = secret;
  return npub(secret);
}
function current() {
  if (!held) throw "Create or restore a key first";
  return held;
}

/** The held key, when `text` is its npub. */
export const heldKey = (text: unknown) =>
  held && text === npub(held) ? held : undefined;

export const setupCommands: Record<string, (args: Args) => unknown> = {
  setup_create: () => hold(generateSecretKey()),
  setup_export: () => nip19.nsecEncode(current()),
  setup_backup({ password }) {
    if (typeof password !== "string" || [...password].length < 12)
      throw "Use a password of at least 12 characters.";
    return encrypt(current(), password, BACKUP_LOG_N);
  },
  setup_open({ ncryptsec, password }) {
    const text = String(ncryptsec ?? "")
      .trim()
      .toLowerCase();
    // log_n is payload byte 1, bits 8-15 of the data: bound scrypt's memory first.
    let bits = 0;
    for (const char of text.slice(11, 14))
      bits = (bits << 5) | BECH32.indexOf(char);
    if (!text.startsWith("ncryptsec1") || ((bits >> 4) & 0xff) > BACKUP_LOG_N)
      throw "This backup can’t be opened here.";
    try {
      return hold(decrypt(text, String(password ?? "")));
    } catch {
      throw "Wrong password, or the backup is damaged.";
    }
  },
  async setup_pair({ code }) {
    pairing?.cancel();
    pairing = receive(String(code ?? ""));
    return pairing.sas;
  },
  async setup_pair_confirm() {
    if (!pairing) throw "Paste a pairing code first.";
    return hold(await pairing.confirm());
  },
  setup_pair_cancel() {
    pairing?.cancel();
    pairing = undefined;
  },
};

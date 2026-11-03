import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
  nip19,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

// NIP-AB target role (crates/pairing/src/NIP-AB.md), run in the key Worker:
// receives the identity Buzz desktop's Pair mobile sends, ported from our
// earlier PWA. The pasted code names the source and the relay; the identity is
// only read once the source sent a matching transcript and the user confirmed
// the same comparison code here.

const KIND = 24134;
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string) {
  const key = await crypto.subtle.importKey("raw", ikm.slice(), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.slice(),
      info: encoder.encode(info),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** NIP-AB uses the raw x-coordinate, not the hashed ECDH output. */
export const ecdh = (secret: Uint8Array, pubkey: string) =>
  secp256k1.getSharedSecret(secret, hexToBytes(`02${pubkey}`)).slice(1, 33);

/** The session id, comparison code and transcript hash of a session. */
export async function derive(
  secret: Uint8Array,
  source: string,
  target: string,
  shared: Uint8Array,
) {
  const id = await hkdf(secret, new Uint8Array(), "nostr-pair-session-id");
  const input = await hkdf(shared, secret, "nostr-pair-sas-v1");
  const code = new DataView(input.buffer).getUint32(0) % 1_000_000;
  const transcript = await hkdf(
    new Uint8Array([
      ...id,
      ...hexToBytes(source),
      ...hexToBytes(target),
      ...input,
    ]),
    secret,
    "nostr-pair-transcript-v1",
  );
  return {
    id: bytesToHex(id),
    sas: String(code).padStart(6, "0"),
    transcript: bytesToHex(transcript),
  };
}

function parse(code: string) {
  const match = /^nostrpair:\/\/([0-9a-f]{64})\?(.+)$/.exec(code.trim());
  const query = new URLSearchParams(match?.[2]);
  const secret = query.get("secret") ?? "";
  const relay = query.get("relay") ?? "";
  if (
    !match?.[1] ||
    code.length > 2048 ||
    !/^[0-9a-f]{64}$/.test(secret) ||
    /^0+$/.test(secret) ||
    !URL.canParse(relay)
  )
    throw "That isn’t a Buzz pairing code.";
  if ((query.get("v") ?? "1") !== "1")
    throw "This pairing code needs a newer version of Buzz.";
  if (query.get("mode") === "recover")
    throw "This code asks for an identity instead of sending one.";
  const url = new URL(relay);
  if (
    url.protocol !== "wss:" &&
    !(
      url.protocol === "ws:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw "This pairing code uses an insecure relay.";
  return { source: match[1], secret: hexToBytes(secret), relay };
}

/** Buzz desktop's `{relayUrl, pubkey, nsec}`, or a bare nsec from Buzz mobile. */
function identity({ payload_type, payload }: Record<string, unknown>) {
  try {
    const data =
      payload_type === "custom"
        ? JSON.parse(String(payload))
        : { nsec: payload };
    const decoded = nip19.decode(String(data.nsec));
    if (
      decoded.type === "nsec" &&
      (payload_type === "nsec" ||
        (payload_type === "custom" &&
          getPublicKey(decoded.data) === data.pubkey))
    )
      return decoded.data;
  } catch {}
  throw "The other device sent an identity this app can’t use.";
}

function same(a: unknown, b: string) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++)
    diff |= a.toLowerCase().charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Joins the session a pairing code opened. `sas` settles once the offer is
 * sent; `confirm` is the user's match and settles with the received secret. */
export function receive(code: string) {
  const { source, secret, relay } = parse(code);
  const key = generateSecretKey();
  const self = getPublicKey(key);
  let shared: Uint8Array;
  try {
    shared = ecdh(key, source);
  } catch {
    throw "That isn’t a Buzz pairing code.";
  }
  const conversation = nip44.v2.utils.getConversationKey(key, source);
  let socket: WebSocket | undefined;
  let byUser = false;
  let bySource = false;
  let payload: Record<string, unknown> | undefined;
  let resolve!: (secret: Uint8Array) => void;
  let reject!: (reason: string) => void;
  const received = new Promise<Uint8Array>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  received.catch(() => {});
  const send = (message: object) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const jitter = (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 31;
    const event = finalizeEvent(
      {
        kind: KIND,
        created_at: now() - jitter,
        tags: [["p", source]],
        content: nip44.v2.encrypt(JSON.stringify(message), conversation),
      },
      key,
    );
    socket.send(JSON.stringify(["EVENT", event]));
  };
  const fail = (reason: string) => {
    reject(reason);
    clearTimeout(timer);
    socket?.close();
  };
  // The pair relay drops connections after 120 s.
  const timer = setTimeout(
    () => fail("Pairing timed out. Copy a new pairing code and try again."),
    115_000,
  );
  // Both consents given and a payload held: only now is it read.
  const accept = () => {
    if (!byUser || !bySource || !payload) return;
    try {
      resolve(identity(payload));
      send({ type: "complete", success: true });
    } catch (error) {
      send({ type: "complete", success: false });
      reject(String(error));
    }
    clearTimeout(timer);
    socket?.close();
  };
  const sas = derive(secret, source, self, shared).then(
    ({ id, sas, transcript }) =>
      new Promise<string>((ready, failed) => {
        const ws = new WebSocket(relay);
        socket = ws;
        let offered = false;
        let auth = "";
        const subscribe = () =>
          ws.send(
            JSON.stringify(["REQ", "pair", { kinds: [KIND], "#p": [self] }]),
          );
        const onEvent = (event: NostrEvent) => {
          let message: Record<string, unknown>;
          try {
            if (
              event.kind !== KIND ||
              event.pubkey !== source ||
              !event.tags.some(
                ([name, value]) => name === "p" && value === self,
              ) ||
              Math.abs(now() - event.created_at) > 180 ||
              !verifyEvent(event)
            )
              return;
            message = JSON.parse(nip44.v2.decrypt(event.content, conversation));
          } catch {
            return;
          }
          if (message.type === "abort")
            fail("Pairing was canceled on the other device.");
          else if (message.type === "sas-confirm" && !bySource) {
            if (same(message.transcript_hash, transcript)) {
              bySource = true;
              accept();
            } else {
              send({ type: "abort", reason: "sas_mismatch" });
              fail("Security verification failed. Pairing was canceled.");
            }
          } else if (message.type === "payload" && bySource && !payload) {
            payload = message;
            accept();
          }
        };
        ws.onopen = subscribe;
        ws.onclose = () => {
          failed("Couldn’t reach the pairing relay. Try again.");
          fail("The pairing connection closed. Try again.");
        };
        ws.onmessage = ({ data }) => {
          let frame: unknown;
          try {
            frame = JSON.parse(String(data));
          } catch {
            return;
          }
          if (!Array.isArray(frame)) return;
          const [type, first, second] = frame;
          if (type === "AUTH" && typeof first === "string") {
            const event = finalizeEvent(
              {
                kind: 22242,
                created_at: now(),
                tags: [
                  ["relay", relay],
                  ["challenge", first],
                ],
                content: "",
              },
              key,
            );
            auth = event.id;
            ws.send(JSON.stringify(["AUTH", event]));
          } else if (type === "OK" && first === auth) subscribe();
          else if (type === "EOSE" && first === "pair" && !offered) {
            offered = true;
            send({ type: "offer", version: 1, session_id: id });
            ready(sas);
          } else if (type === "EVENT" && first === "pair") onEvent(second);
        };
      }),
  );
  return {
    sas,
    confirm() {
      byUser = true;
      accept();
      return received;
    },
    cancel() {
      send({ type: "abort", reason: "user_denied" });
      fail("Pairing was canceled.");
    },
  };
}

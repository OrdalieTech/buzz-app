import { Channel, invoke } from "@tauri-apps/api/core";
import type { LiveSocket } from "./live";

/** No reconnect policy here. live.ts owns connection generations and NIP-42. */
export class NativeSocket implements LiveSocket {
  readyState = 0;
  // Cold native admission can use three bounded 30s phases: discovery,
  // assertion issuance and socket upgrade. NIP-42 gets 10s after native open.
  readonly connectionTimeoutMs = 90000;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onerror: LiveSocket["onerror"] = null;
  onclose: LiveSocket["onclose"] = null;
  private readonly id = crypto.randomUUID();
  private browser?: WebSocket;
  private closed = false;
  constructor(private readonly url: string) {
    void this.connect();
  }
  private async connect() {
    try {
      const onEvent = new Channel<
        | { type: "text"; data: string }
        | { type: "closed"; code: number | null; reason: string | null }
        // A refusal after the upgrade, ending the socket like its 401 would.
        | { type: "refused"; reason: string }
        // The assertion is due for refresh: a planned close, marked `renew`.
        | { type: "renew" }
      >((event) => {
        if (this.closed) return;
        if (event.type === "text")
          this.onmessage?.(new MessageEvent("message", { data: event.data }));
        else if (event.type === "refused") this.refuse(event.reason);
        else if (event.type === "renew")
          this.finish(undefined, undefined, true);
        else this.finish(event.code ?? undefined, event.reason ?? undefined);
      });
      const mode = await invoke<"public" | "native">("relay_socket_connect", {
        id: this.id,
        relay: this.url,
        onEvent,
      });
      if (this.closed) {
        void invoke("relay_socket_close", { id: this.id }).catch(() => {});
        return;
      }
      if (mode === "public") {
        // Native discovery explicitly admitted a valid non-FI community.
        const ws = new WebSocket(this.url);
        this.browser = ws;
        ws.onopen = (event) => {
          if (!this.closed) {
            this.readyState = 1;
            this.onopen?.(event);
          }
        };
        ws.onmessage = (event) => {
          if (!this.closed) return this.onmessage?.(event);
        };
        ws.onerror = (event) => {
          if (!this.closed) this.onerror?.(event);
        };
        ws.onclose = (event) => this.finish(event?.code, event?.reason);
      } else {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        await invoke("relay_socket_start", { id: this.id });
      }
    } catch (error) {
      if (this.closed) return;
      this.refuse(
        typeof error === "string"
          ? error
          : "Native relay connection unavailable",
      );
    }
  }
  private refuse(message: string) {
    const event = Object.assign(new Event("error"), {
      // Connection failures keep live.ts's bounded reconnect policy. Explicit
      // credential/protocol refusals require user recovery, not more issuance.
      terminal: [
        "Federated sign-in is required",
        "Federated identity is not configured for this community",
        "reauthentication-required",
        "binding-mismatch",
        "authorization-denied",
        // NIP-FA: the issuer refused the grant; final for this session.
        "grant-refused",
        "invalid-proof",
        "invalid-assertion",
        // This computer's clock is too far behind the issuer's.
        "clock-skew",
        "invalid-response",
        "invalid-expiry",
        "invalid-viewer",
        "adapter-refused",
        // The relay's 403: a decision, not an outage. 401/503 reconnect.
        "relay-forbidden",
        "response-too-large",
        "Invalid federated community discovery",
        "Incomplete federated community discovery",
        "Unsupported federated community discovery",
      ].includes(message),
      message,
    });
    this.onerror?.(event);
    this.finish();
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("Socket is not open");
    if (this.browser) this.browser.send(data);
    else
      void invoke("relay_socket_send", { id: this.id, data }).catch(() =>
        this.finish(),
      );
  }
  private finish(code?: number, reason?: string, renew = false) {
    if (this.closed) return;
    this.close();
    const event = new CloseEvent("close", {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.onclose?.(renew ? Object.assign(event, { renew }) : event);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.browser?.close();
    void invoke("relay_socket_close", { id: this.id }).catch(() => {});
  }
}
export const nativeSocket = (url: string): LiveSocket => new NativeSocket(url);

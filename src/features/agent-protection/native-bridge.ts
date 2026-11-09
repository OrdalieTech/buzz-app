import type { HostMcpServer, McpHandler } from "../host/service";
import {
  ALL_PHASES,
  ProtectionDenied,
  type AgentProtection,
  type ProtectionAction,
} from "./service";

export function protectionEnvironment(protection: AgentProtection) {
  const phases = protection.phases ?? ALL_PHASES;
  return {
    BUZZ_SECURITY_CONTEXT: phases.context ? "1" : "0",
    BUZZ_SECURITY_TOOL: phases.tool ? "1" : "0",
    BUZZ_SECURITY_TOOL_RESULT: phases["tool-result"] ? "1" : "0",
  };
}

/** A native worker has one immutable agent/policy binding. Its requests can
 * describe evidence, but cannot choose policy, reviewer or requesting identity. */
export async function nativeProtectionBridge(
  serve: (handler: McpHandler) => Promise<HostMcpServer>,
  protection: AgentProtection,
) {
  protection.assertAvailable();
  const lifetime = new AbortController();
  let pending = 0;
  // Numbers checks as they start, so a turn can tell its own from earlier ones.
  let started = 0;
  // Why the provider denied a session's model input, and in which check,
  // until its runtime takes it to tell people why the turn stopped. One nobody
  // takes ages out, as at most as many as can be checked at once are kept.
  const explained = new Map<string, { reason: string; check: number }>();
  const server = await serve(async (message) => {
    const call = message as {
      id?: string;
      method?: string;
      params?: ProtectionAction;
    };
    if (call?.method === "initialize")
      return {
        jsonrpc: "2.0",
        id: call.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "buzz-security", version: "2" },
        },
      };
    if (call?.method === "notifications/initialized") return undefined;
    if (call?.method === "ping")
      return { jsonrpc: "2.0", id: call.id, result: {} };
    const action = call?.params;
    if (
      typeof call?.id !== "string" ||
      call?.method !== "buzz/security/check" ||
      !action ||
      !["context", "tool", "tool-result"].includes(action.kind) ||
      typeof action.session !== "string" ||
      !action.session ||
      !["content,kind,session", "command,content,kind,session"].includes(
        Object.keys(action).sort().join(","),
      ) ||
      (Object.hasOwn(action, "command") &&
        typeof action.command !== "string") ||
      pending >= 16
    )
      throw new Error("Invalid native security request");
    pending++;
    const check = ++started;
    try {
      await protection.check(structuredClone(action), lifetime.signal);
      return { jsonrpc: "2.0", id: call.id, result: { allowed: true } };
    } catch (error) {
      // A check from an earlier turn that settles late keeps a newer reason.
      if (
        action.kind === "context" &&
        error instanceof ProtectionDenied &&
        error.reason &&
        (explained.get(action.session)?.check ?? 0) < check
      ) {
        explained.delete(action.session);
        explained.set(action.session, { reason: error.reason, check });
        if (explained.size > 16) {
          const [oldest = ""] = explained.keys();
          explained.delete(oldest);
        }
      }
      return { jsonrpc: "2.0", id: call.id, result: { allowed: false } };
    } finally {
      pending--;
    }
  });
  void server.closed.then(() => lifetime.abort());
  const authorization = server.headers.find(
    (header) => header.name.toLowerCase() === "authorization",
  )?.value;
  if (!authorization?.startsWith("Bearer ")) {
    await server.close();
    throw new Error("The native security bridge has no authentication");
  }
  return {
    env: {
      ...protectionEnvironment(protection),
      BUZZ_SECURITY_URL: server.url,
      BUZZ_SECURITY_TOKEN: authorization.slice(7),
    },
    /** Starts a turn of `session`. What it returns takes the reason given for
     * denying model input in a check started since, if any. */
    explainer(session: string) {
      const since = started;
      return () => {
        const denial = explained.get(session);
        explained.delete(session);
        return denial && denial.check > since ? denial.reason : undefined;
      };
    },
    async close() {
      lifetime.abort();
      await server.close();
    },
  };
}

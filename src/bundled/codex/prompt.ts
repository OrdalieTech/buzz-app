import { TOP_LEVEL_PROMPT, CHANNEL_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import { MENTION_PROMPT } from "../../features/agent-harness/base-prompt";
import { coreMemorySection } from "../../features/agent-harness/core-memory";
import {
  type ConversationWake,
  unframed,
  wakeSection,
} from "../../features/agent-harness/plugin-wake";
import { composeBase } from "../../features/agent-harness/sections/compose";
import type { Facts } from "../../features/agent-harness/sections/index";
import type { AgentKey } from "../../features/agents/membership";
import type { AgentHandle } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import {
  type AuthorNames,
  eventBody,
  quoted,
} from "../../features/agent-harness/turn-records";
import type { Config } from "./config";

/** A conversation's routing default. Solo chats forbid replies; an addressed
 * channel wake allows the Interest to direct a thread reply. */
export type Conversation = {
  channelId: string;
  community?: true;
  name: string;
  root?: string;
  topLevel?: true;
  /** A channel-level default, without the Solo chat reply restriction. */
  threadReplies?: true;
};
export const rootOf = (event: EventData) =>
  threadReference(event)?.rootId ?? event.id;
export function developerInstructions(
  agent: Pick<AgentHandle, "name" | "pubkey">,
  /** Whether each Buzz thread is a Codex thread of its own. */
  scope: Config["scope"],
  /** The agent's workspace, absolute, when the thread runs in a folder of
   * the conversation's own instead. */
  workspace?: string,
  /** What the thread is: see `sessionPlace`. */
  place?: Facts["place"],
) {
  return `You are ${agent.name} (pubkey ${agent.pubkey}), a coding agent in Buzz.
The buzz namespace provides the shared Buzz tools, including messages, reactions, reads, uploads, canvas, and encrypted memory. Prefer these tools for Buzz operations. You may use the buzz CLI through the agent-specific BUZZ_CREDENTIAL_PROVIDER supplied by the runtime to this thread's shell commands. The host handles access and signing as this agent without exposing private keys. If that provider is unavailable or refuses an operation, use the available Buzz tools or report the blocker. Do not look for credentials, read private keys, change the provider, or pair the CLI as your owner. Use Codex's native coding tools in the workspace.

${composeBase({ scope, ownFolder: workspace, place }).text}`;
}
/** What a conversation's Codex thread is. A conversation without a root is
 * a whole one, as every conversation of an agent with channel scope is. */
export const sessionPlace = (conversation: {
  root?: string | undefined;
}): NonNullable<Facts["place"]> =>
  conversation.root ? "thread" : "conversation";

/** Codex truncates the middle of any additional-context value over 1,000
 * tokens, which it estimates as 4 UTF-8 bytes each. */
const CONTEXT_VALUE_BYTES = 4_000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** The agent's current identity, instructions, team, and core memory as turn
 * context: a resumed Codex thread keeps its original developer instructions.
 * Codex orders values by key, so text over its per-value limit continues in
 * `buzz.instructions.001` onward, split at line breaks where possible. */
export function turnContext(
  agent: AgentHandle,
  settings: Config,
  team = "",
  /** The agent's `core` memory: `null` when it has none, undefined if unread. */
  memory?: string | null,
  repositories = "",
) {
  const core = coreMemorySection(memory);
  const text = `You are ${agent.name} (pubkey ${agent.pubkey}).\nCurrent Buzz custom instructions replace all prior Buzz custom instructions. An empty section means no custom instructions apply.\n<agent-instructions>\n${settings.instructions}\n</agent-instructions>\n\nCurrent team sections replace all prior team sections. None means you are on no team.${team ? `\n${team}` : ""}${core ? `\n\nCurrent core memory replaces all prior core memory.\n${core}` : ""}`;
  const community =
    settings.scope === "community"
      ? "\nThis is the agent's one shared community session. Each request's context replaces all earlier routing and delivery-mode instructions. Only a <realtime_delegation> turn is a spoken request; other requests follow their own posting instructions. Community scope grants no additional access."
      : "";
  const values = [""];
  let size = 0;
  // None of it is Buzz's event or steer section.
  for (const line of unframed(
    `${text}${community}${repositories ? `\n\n${repositories}` : ""}`,
  ).split(/(?<=\n)/)) {
    // A line over the limit splits by code point.
    const pieces = bytes(line) > CONTEXT_VALUE_BYTES ? [...line] : [line];
    for (const piece of pieces) {
      const length = bytes(piece);
      if (size + length > CONTEXT_VALUE_BYTES) {
        values.push("");
        size = 0;
      }
      values[values.length - 1] += piece;
      size += length;
    }
  }
  return Object.fromEntries(
    values.map((value, index) => [
      index
        ? `buzz.instructions.${String(index).padStart(3, "0")}`
        : "buzz.instructions",
      { kind: "application", value },
    ]),
  );
}

export function turnInput(
  /** The membership the turn is for, which its usage is read by. */
  agent: AgentKey,
  event: EventData,
  conversation: Conversation,
  text: string,
  steering = false,
  /** The Buzz tools' note for the end of the turn, if any. */
  note?: string,
  /** A plugin's wake, whose section takes the place of `event`'s. */
  wake?: ConversationWake,
  /** The names shown beside the event author's pubkey, when known. */
  names?: AuthorNames,
) {
  const section = steering
    ? "new-message-arrived-while-you-were-working"
    : "buzz-event";
  const body = wake ? wakeSection(wake) : eventBody(event, text, names);
  const routing = conversation.topLevel
    ? { posting: "top-level" }
    : { session_thread: conversation.root, reply_to: rootOf(event) };
  const replyGuidance = steering
    ? wake
      ? `When posting about this wake, pass channel "${conversation.channelId}" explicitly to send${conversation.topLevel ? " and omit reply" : ` and use reply "${rootOf(event)}"`}. Leave out the request field for the wake. You can continue working on other requests.`
      : "When answering requests from different conversations, use Buzz send with the request ID for each reply. You can answer one request and continue working on another."
    : "";
  return `<context>\n${quoted({ agent, channel_id: conversation.channelId, channel_name: conversation.name, session_scope: conversation.community ? "community" : conversation.root ? "thread" : "channel", ...routing })}\n</context>\n${conversation.topLevel ? `${conversation.threadReplies ? CHANNEL_LEVEL_PROMPT : TOP_LEVEL_PROMPT}\n` : ""}${wake ? "" : `${MENTION_PROMPT}\n`}${wake && !steering ? body : `<${section}>\n${body}\n</${section}>`}${replyGuidance ? `\n\n${replyGuidance}` : ""}${note ? `\n\n${note}` : ""}`;
}
/** The readable part of a conversation's thread name; earlier versions used
 * it alone. */
export function sessionTitle(agentName: string, conversation: Conversation) {
  if (conversation.community) return `Buzz community · ${agentName}`;
  return `Buzz #${conversation.name.replace(/\s+/g, " ").slice(0, 100)}${conversation.root ? ` · thread ${conversation.root.slice(0, 8)}` : ""} · ${agentName}`;
}
/** Names the agent's conversation in its thread names, so its threads can be
 * found from any build of the app, each of which saves its own bindings. A
 * 64-bit FNV-1a hash: stable and synchronous, so naming a thread does not
 * reorder concurrent turn starts. */
export function sessionTag(
  agent: AgentKey,
  conversation: Pick<Conversation, "channelId" | "root" | "community">,
) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(
    JSON.stringify([
      agent,
      conversation.community ? "@community" : conversation.channelId,
      conversation.community ? "channel" : (conversation.root ?? "channel"),
    ]),
  ))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `buzz:${hash.toString(16).padStart(16, "0")}`;
}
export function sessionName(
  agent: Pick<AgentHandle, "key" | "name">,
  conversation: Conversation,
) {
  return `${sessionTitle(agent.name, conversation)} · ${sessionTag(agent.key, conversation)}`;
}

#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { entry, exportSession, text } from "./session-viewer.mjs";

// Tool results are a string or a list of text/image content blocks.
const resultText = (content) =>
  Array.isArray(content) &&
  content.every((block) => typeof block?.text === "string")
    ? content.map((block) => block.text).join("\n")
    : content;
// An exact-record event is a section holding its JSON event, then a quoted
// `Request:` line. Older events carry `Content: <message>` followed by a
// `Tags:` line. Any other `Request:` line is the message's own text.
const EVENT_SECTION =
  /^<(buzz-event|new-message-arrived-while-you-were-working)(?:\s[^<>]*)?>\n(\{[^\n]*\})\nRequest: ("[^\n]*")\n<\/\1>$/gm;
const eventRequest = (event, request) => {
  try {
    const pubkey = JSON.parse(event)?.pubkey;
    const value = JSON.parse(request);
    return typeof pubkey === "string" && typeof value === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};
const buzzRequest = (value) => {
  const requests = [...value.matchAll(EVENT_SECTION)]
    .map((match) => eventRequest(match[2], match[3]))
    .filter((request) => request !== undefined);
  if (requests.length) return requests.join("\n\n");
  return value.match(/^Content: ([\s\S]*?)\nTags: /m)?.[1];
};
// Name a tool call's target; shell commands already show as the input.
const target = (input) =>
  ["file_path", "description", "pattern", "url", "query"]
    .map((key) => input?.[key])
    .find((value) => typeof value === "string") ?? "";

export function buildClaude(records) {
  const messages = records.filter((record) => record?.message != null);
  const results = new Map(
    messages.flatMap((record) =>
      Array.isArray(record.message.content)
        ? record.message.content
            .filter((block) => block?.type === "tool_result")
            .map((block) => [block.tool_use_id, block])
        : [],
    ),
  );
  const entries = [];
  let model;
  // Claude writes `prompt_snapshot`s in pairs: the first, before a
  // response, lacks the CLI prefix and tools that the second fills in. Show the
  // pair as one, at the first, and again only when the prompt or tools change.
  let system;
  let tools;
  const deferred = records.some(
    (record) => record?.attachment?.type === "deferred_tools_delta",
  );
  for (const record of records) {
    const { timestamp, type, isMeta, message, attachment } = record;
    if (type === "attachment" && attachment?.type === "prompt_snapshot") {
      const key = JSON.stringify(attachment.systemPrompt);
      const blocks = [
        attachment.cliPrefix,
        ...(attachment.systemPrompt ?? []),
      ].filter((block) => typeof block === "string" && block.trim());
      const prompt = blocks.join("\n\n");
      const row = (at) =>
        entry.instructions(at, "System prompt", prompt, {
          scope: "system",
          blocks,
        });
      if (prompt && key !== system?.key) {
        system = { key, prefixed: !!attachment.cliPrefix, at: entries.length };
        entries.push(row(timestamp));
      } else if (prompt && attachment.cliPrefix && !system.prefixed) {
        system.prefixed = true;
        entries[system.at] = row(entries[system.at].timestamp);
      }
      // `schema` is the wire definition; name and description show apart.
      const defs = (attachment.tools ?? []).map((tool) => {
        const {
          name: _,
          description: __,
          ...schema
        } = tool.schema ?? tool.input_schema ?? {};
        return { name: tool.name, description: tool.description, schema };
      });
      if (defs.length && JSON.stringify(defs) !== tools) {
        tools = JSON.stringify(defs);
        const row = (at) =>
          entry.tools(at, `Tools · ${defs.length}`, defs, {
            note: deferred
              ? "Deferred tools load on demand; only their names are recorded, in the deferred tools reminder."
              : null,
          });
        if (system && !system.tools)
          entries.splice(system.at + 1, 0, row(entries[system.at].timestamp));
        else entries.push(row(timestamp));
      }
      if (system && defs.length) system.tools = true;
      continue;
    }
    // Other attachments that reached the model carry their rendered text.
    if (type === "attachment") {
      const body = (record.rendered ?? [])
        .map((part) => text(part?.content))
        .join("\n\n")
        .trim();
      if (body)
        entries.push(
          entry.instructions(
            timestamp,
            [record.renderedRole, attachment?.type?.replaceAll("_", " ")]
              .filter(Boolean)
              .join(" · ") || "context",
            body,
            { scope: record.renderedRole },
          ),
        );
      continue;
    }
    if (message == null) continue;
    if (message.model && message.model !== model) {
      model = message.model;
      entries.push(entry.model(timestamp, model));
    }
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content }];
    if (type === "user") {
      const body = blocks
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n\n")
        .trim();
      if (body)
        entries.push(
          isMeta
            ? entry.instructions(timestamp, "meta", body, { scope: "user" })
            : entry.user(timestamp, body, buzzRequest(body)),
        );
      for (const block of blocks)
        if (block?.type !== "text" && block?.type !== "tool_result")
          entries.push(entry.other(timestamp, block?.type ?? "content", block));
      continue;
    }
    for (const block of blocks) {
      if (block?.type === "text" && block.text?.trim())
        entries.push(entry.assistant(timestamp, block.text.trim()));
      else if (block?.type === "thinking") {
        if (block.thinking?.trim())
          entries.push(entry.thinking(timestamp, block.thinking.trim()));
      } else if (
        block?.type === "tool_use" &&
        /(^|__)buzz__send$/.test(block.name) &&
        typeof block.input?.text === "string" &&
        // A failed or unanswered send stays a tool row with its result: it is
        // what someone looking for a missing reply needs to see.
        results.has(block.id) &&
        results.get(block.id).is_error !== true
      ) {
        entries.push(entry.sent(timestamp, block.input.text));
      } else if (block?.type === "tool_use") {
        const result = results.get(block.id);
        entries.push(
          entry.tool(timestamp, {
            name: block.name,
            detail: target(block.input),
            input: block.input?.command ?? block.input,
            result: result && resultText(result.content),
            error: result?.is_error === true,
          }),
        );
      } else if (block?.type !== "text")
        entries.push(entry.other(timestamp, block?.type ?? "content", block));
    }
  }
  const first = messages[0] ?? {};
  const unique = (key) => [
    ...new Set(messages.map((record) => record[key]).filter(Boolean)),
  ];
  return {
    title: "Claude session",
    info: [
      `Session: ${first.sessionId}`,
      `Working directory: ${unique("cwd").join(", ")}`,
      `Started: ${first.timestamp}`,
    ],
    entries,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  exportSession(buildClaude);

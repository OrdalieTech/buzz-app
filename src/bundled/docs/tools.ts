import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import {
  DocConflict,
  docAddress,
  docUrl,
  docMarkdownLink,
  parseDocUrl,
  readDoc,
  readDocHistory,
  saveDoc,
  type Doc,
  type DocRead,
} from "./model";
import { readDocsPage, type DocsWorkspace } from "./workspace";
import agentGuide from "./agent-guide.md?raw";

const str = { type: "string" };
const addressFields = { id: str, channel: str };
const string = (args: Record<string, unknown>, key: string) => {
  if (typeof args[key] !== "string") throw new Error(`${key} is required.`);
  return args[key] as string;
};
const asReader =
  (client: BuzzClient): DocRead =>
  (filters) =>
    client.query(filters);
const format = (doc: Doc, community: string) =>
  JSON.stringify({
    id: doc.id,
    channel: doc.channel,
    revision: doc.revision,
    title: doc.title,
    deleted: doc.deleted,
    link: docUrl(doc, community),
    message: docMarkdownLink(doc, community),
    markdown: doc.markdown,
  });

/** Reads and content writes always use the caller's custody/relay connection.
 * The owner's coordinator allocates new storage and admits only the verified creating agent. */
export function docTools(
  current: (client: BuzzClient) => DocsWorkspace | undefined,
): AddedTool[] {
  function workspace(client: BuzzClient) {
    const value = current(client);
    if (
      !value ||
      value.session.viewer !== client.owner ||
      value.session.relayAuthor !== client.relayAuthor
    )
      throw new Error(
        "Working docs require this agent’s owning community to be connected.",
      );
    return value;
  }
  const community = (client: BuzzClient) =>
    workspace(client).session.scope.replace(/:[0-9a-f]{64}$/, "");
  const requireWrites = (client: BuzzClient) => {
    const value = workspace(client);
    if (!value.session.configArtifactWriter)
      throw new Error(
        "This connection does not advertise working-doc revision support.",
      );
    return value;
  };
  function tool(
    name: string,
    description: string,
    properties: Record<string, object>,
    required: string[],
    call: AddedTool["call"],
  ): AddedTool {
    return {
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      async call(client, context, args) {
        try {
          return await call(client, context, args);
        } catch (error) {
          if (error instanceof DocConflict)
            throw new Error(
              `This request did not confirm your content as the current revision. Keep your proposed text, call doc_get, merge with the latest content and retry against its revision. Current doc: ${format(error.current, community(client))}`,
            );
          throw error;
        }
      },
    };
  }
  return [
    tool(
      "doc_help",
      "Create document deliverables as live Docs instead of attaching .md files. Start here for the create/verify/link/update workflow, Docs plugin links, reading and updating shared docs, revision conflicts, permissions, or missing tools. Use doc_* tools for these docs; Canvas and published notes_* tools read different content.",
      {},
      [],
      async () => agentGuide,
    ),
    tool(
      "doc_get",
      "Read a working doc from its Docs plugin URL, or id and channel. Search accessible docs by title with q, or omit arguments to list. Search/listing are paged; keep q and pass the returned cursor. Results include links and revisions for doc_set. For guidance use doc_help. Published agent docs still use notes_get.",
      {
        ...addressFields,
        url: str,
        q: str,
        cursor: {
          type: "object",
          properties: { until: { type: "integer" }, before_id: str },
          required: ["until", "before_id"],
          additionalProperties: false,
        },
      },
      [],
      async (client, _context, args) => {
        const origin = community(client);
        if (
          args.url !== undefined ||
          args.id !== undefined ||
          args.channel !== undefined
        ) {
          if (args.q !== undefined || args.cursor !== undefined)
            throw new Error(
              "Read a doc address or search/list docs, not both.",
            );
          const linked =
            args.url === undefined
              ? undefined
              : parseDocUrl(string(args, "url"));
          if (
            args.url !== undefined &&
            (!linked || args.id !== undefined || args.channel !== undefined)
          )
            throw new Error("Provide one valid doc URL, or id and channel.");
          if (linked && linked.community !== origin)
            throw new Error(
              `This doc belongs to ${linked.community}; this agent is connected to ${origin}. Ask from the doc’s community.`,
            );
          const address = linked ?? docAddress(args);
          return format(await readDoc(asReader(client), address), origin);
        }
        if (
          args.q !== undefined &&
          (typeof args.q !== "string" || args.q.length > 512)
        )
          throw new Error("Use a title query of at most 512 characters.");
        const query =
          typeof args.q === "string" ? args.q.trim().toLowerCase() : "";
        const page = await readDocsPage(
          asReader(client),
          client.pubkey,
          client.relayAuthor ?? "",
          args.cursor as Parameters<typeof readDocsPage>[3],
        );
        return JSON.stringify({
          docs: page.docs
            .filter(
              (doc) => !doc.deleted && doc.title.toLowerCase().includes(query),
            )
            .map((doc) => ({
              id: doc.id,
              channel: doc.channel,
              revision: doc.revision,
              title: doc.title,
              deleted: doc.deleted,
              link: docUrl(doc, origin),
            })),
          more: page.more,
          ...(page.more ? { cursor: page.cursor } : {}),
        });
      },
    ),
    tool(
      "doc_set",
      "Create or edit a live Markdown document; prefer this to .md attachments unless a file is requested. The result’s message is a ready-to-post Doc link. Verify with doc_get, then reply using that link. To create, omit channel/revision and reuse a new UUID id on retries; only the owner and creating agent receive access. Ask the owner to use Share doc if someone else needs access. To edit, use channel/revision from doc_get; on conflict read, merge and retry. Restore deleted docs with doc_delete restore:true. Pass text or a UTF-8 path.",
      { ...addressFields, revision: str, title: str, text: str, path: str },
      ["id", "title"],
      async (client, _context, args) => {
        requireWrites(client);
        if (args.revision !== undefined && args.channel === undefined)
          throw new Error(
            "Editing requires channel and id from doc_get together with revision. Omit revision only when creating a new doc.",
          );
        if ((args.text === undefined) === (args.path === undefined))
          throw new Error("Provide exactly one of text or path.");
        const markdown =
          args.path === undefined
            ? string(args, "text")
            : new TextDecoder("utf-8", { fatal: true }).decode(
                await client.read(string(args, "path")),
              );
        const draft = { title: string(args, "title"), markdown };
        if (args.channel === undefined) {
          const value = workspace(client);
          const doc = await value.create(
            { ...draft, id: string(args, "id") },
            undefined,
            {
              key: client.pubkey,
              read: asReader(client),
              publish: (template) => client.publish(template),
            },
          );
          return format(doc, community(client));
        }
        const address = docAddress(args);
        const read = asReader(client);
        const base = await readDoc(read, address);
        if (base.revision !== string(args, "revision"))
          throw new DocConflict(base);
        if (base.deleted)
          throw new Error(
            "This doc is deleted. Read doc_history for retained title/content, then use doc_delete with restore:true, the current revision, title and text to restore it.",
          );
        return format(
          await saveDoc(
            read,
            (template) => client.publish(template),
            base,
            draft,
          ),
          community(client),
        );
      },
    ),
    tool(
      "doc_history",
      "Read retained revisions of a connected doc. Access is the same as the current doc; offset pages are 100 revisions. To restore an older version, read it, then doc_set its contents against the current revision.",
      {
        ...addressFields,
        offset: { type: "integer", minimum: 0, maximum: 10000 },
      },
      ["id", "channel"],
      async (client, _context, args) =>
        JSON.stringify(
          await readDocHistory(
            asReader(client),
            docAddress(args),
            args.offset === undefined ? 0 : Number(args.offset),
          ),
        ),
    ),
    tool(
      "doc_delete",
      "Soft-delete or restore a connected doc using its current revision. Restoring requires a title and Markdown text. The backing channel and sharing are retained.",
      {
        ...addressFields,
        revision: str,
        restore: { type: "boolean" },
        title: str,
        text: str,
      },
      ["id", "channel", "revision"],
      async (client, _context, args) => {
        requireWrites(client);
        const read = asReader(client),
          base = await readDoc(read, docAddress(args));
        if (base.revision !== string(args, "revision"))
          throw new DocConflict(base);
        const restore = args.restore === true;
        const draft = restore
          ? { title: string(args, "title"), markdown: string(args, "text") }
          : { title: base.title, markdown: "" };
        return format(
          await saveDoc(
            read,
            (template) => client.publish(template),
            base,
            draft,
            restore ? "restore" : "delete",
          ),
          community(client),
        );
      },
    ),
  ];
}

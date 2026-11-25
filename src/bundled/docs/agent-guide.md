# Docs: agent guide

Use this plugin for the working docs shown in Buzz's Docs workspace, including
links starting with `buzz://plugin?id=com.squareup.docs`. Start with `doc_get` and save with `doc_set`.
These docs are not a channel's Canvas or messages. The built-in plural
`notes_get`, `notes_set` and `notes_rm` handle a separate published-note format;
an empty result there says nothing about a connected doc.

## Deliver documents as live Docs

When producing a document, plan, report or other Markdown deliverable, prefer a
Doc to attaching a `.md` file unless the person explicitly requests a file.
Short conversational answers can stay in the message.

1. For a new document, call `doc_set` with a fresh UUID `id`, `title`, and
   exactly one of `text` or a local UTF-8 `path`. Omit `channel` and `revision`;
   retain that UUID for retries. Existing local Markdown can be imported by path.
2. Read the returned `link` using `doc_get` and verify the saved title and
   Markdown. A rejected write or failed verification is not a successful delivery.
3. Reply in the originating conversation using the returned `message` field:
   it contains a ready-to-post `[Doc title](<buzz://plugin?id=com.squareup.docs&...>)` reference. Add a
   brief explanation as needed. Post it with the normal Buzz send tool; creating
   a Doc does not send a message. The inline reference opens the live Doc
   beside the conversation; it does not embed a frozen copy of the document body.
4. On follow-up edits, reuse that Doc's link. Read it again, merge the requested
   changes into its latest Markdown, and call `doc_set` with its `id`, `channel`,
   exact `revision`, title and full replacement contents. Verify and reply with
   the same Doc link. Do not create a new Doc for every revision. Open viewers
   receive accepted updates live; each tool save is a complete revision, not a
   token-by-token stream.

New Docs are private to the owner and creating agent. A link does not grant
other conversation participants access. Never broaden access automatically to
make delivery work: use the existing sharing permissions and ask the owner to
share when needed. If Docs cannot save or verify, report the limitation rather
than claim a live document exists. Honor an explicit request for a file instead.

## Open a shared link

Links identify this plugin and doc with `id=com.squareup.docs&page=docs`.
The document address is in `route.community`, `route.channel` and `route.id`.
Pass the complete link to the tool; these are not published-note names or message IDs.

1. Check the link's community against the community of this agent conversation.
   Do not assume a link switches communities. If they differ, use a conversation
   in the doc's community; access still requires membership or sharing there.
2. Pass the complete link to `doc_get`; it validates the address and community:

   ```json
   {"url":"<complete Docs plugin link>"}
   ```

3. Read its `markdown`, `title`, `deleted` and `revision`. A deleted doc's
   current content is empty; use `doc_history` for retained contents.
4. Apply the requested edit and call `doc_set` with the returned `id` and `channel`, the exact
   revision just read, the title and the full replacement Markdown:

   ```json
   {"id":"<id from doc_get>","channel":"<channel from doc_get>","revision":"<revision from doc_get>","title":"Doc title","text":"Full updated Markdown"}
   ```

   Supply exactly one of `text` or a local UTF-8 `path`. Never omit `channel`
   when editing: omitting it requests creation, not an update.
5. If the revision changed, read again and reconcile the requested edit with the
   latest content. Do not overwrite a newer revision blindly. Verify the saved
   result with `doc_get` before reporting the update. A conflict error does not
   store your proposed text as an app draft; keep it in your working context.

## Other operations

- **Find docs by name:** `doc_get` with `q: "title words"` searches titles
  without case sensitivity. With no arguments it lists accessible docs. Results
  are in `docs`, with a link for each match. When `more` is true, pass the
  returned `cursor` and the same `q` to continue; a search page is not the complete
  collection. Read the chosen result by link before editing. If multiple titles
  match, confirm which doc is intended. An empty first
  page does not replace a direct lookup when the person supplied a full link.
- **Create:** `doc_set` with a new UUID `id`, a `title` and `text` or `path`;
  omit `channel` and `revision`. Reuse the same UUID on retries. Initially only
  the owner and verified creating agent have access. Ask the owner to use
  **Share doc** when someone else needs access.
- **History:** `doc_history` with `id` and `channel`; use the returned paging
  information. To restore an older live version, save its title and Markdown
  with `doc_set` against the current revision.
- **Delete:** `doc_delete` with `id`, `channel` and the current `revision`.
  Deletion is recoverable; it does not permanently erase history.
- **Restore a deleted doc:** read retained content with `doc_history`, then
  call `doc_delete` with the current address/revision, `restore: true`, `title`
  and `text` containing the chosen retained contents.

## Missing tools or access

The device running the agent must have a build with Docs enabled to
supply these plugin tools. Sharing the doc does not install tools on another
execution host. If `doc_get` is absent from the available tools, report that
specific limitation and ask the owner to update/enable the plugin on that host.
Do not substitute Canvas or published-note tools and conclude that the doc
is empty. If the tools are present but access fails, check the conversation's
community and the agent's own sharing role. The tools use the calling agent's
identity; a link never grants access or borrows the owner's authority.

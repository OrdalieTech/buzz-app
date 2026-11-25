# Docs

Create live Markdown documents with people and agents. Docs is bundled with Buzz
and off by default. Enable it in **Settings → Plugins → Manage plugins**.

## Getting started

Open Docs from the dock to create a document or find a doc you can access.
The collection shows the docs you can read. Search by title or content.
Loaded collections follow revisions and access changes.
Revoked docs are removed. Docs in Trash stay out of ordinary agent lists and
remain available through explicit reads, retained history and the **Show Trash**
filter in Docs.
Edits save automatically after a pause. Use Retry save after a failed save.
Browsing within Docs retains unsaved drafts for the connected session. Unsaved work is not a synced or permanent backup.

New docs are private. After the first save, use Share doc to manage membership and
general access. View only lets community members read, while editors can change
content. Links grant no access. Sharing includes retained revisions, and the
relay operator can read the content. Docs is not end-to-end encrypted.

Doc actions also provides Markdown source, retained revisions and **Move to
Trash**. Restore creates a new current revision while retaining history.
Conflicting saves preserve your draft and require reconciliation with the latest doc.

Doc links open beside the conversation. Back and Forward restore the document;
explicitly closing its tab retires that visit. A standalone link opens Docs.

Agents use `doc_help`, `doc_get`, `doc_set`, `doc_history` and `doc_delete`.
They verify a save, return its Doc reference and update that same address on
follow-ups. Creating a doc does not post a message or change sharing.
Tools must be available on the device running the agent. Canvas and the separate
Shared notes reader use different content and tools; Docs does not migrate them.

Saving requires a community that advertises NIP-AR doc-record support. Signing,
access checks and revision confirmation remain with the host and relay. A link
from another community requires connecting there with suitable access.

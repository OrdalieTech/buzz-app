import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isTransientFailure, readErrorKind } from "../../features/relay/errors";
import { retryRead } from "../../features/relay/read-retry";
import {
  DOC_KIND,
  DOC_PAGE,
  docKey,
  docTag,
  parseDoc,
  type Doc,
} from "./model";
import type { DocsPage, DocsWorkspace } from "./workspace";
import { useLiveUpdatesInterrupted } from "./live-updates";

function cancelledRead(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    readErrorKind(error) === "cancelled"
  );
}

/** The Docs browser retains only the loaded, currently readable catalogue. */
export function useDocsCollection(workspace: DocsWorkspace) {
  const current = useRef<DocsPage>({ docs: [], more: false });
  const [collection, publish] = useState(current.current);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const liveInterrupted = useLiveUpdatesInterrupted(
    workspace.session.live,
    (channel) => collection.docs.some((doc) => doc.channel === channel),
  );
  const listing = useRef<AbortController | undefined>(undefined);
  const reading = useRef<AbortController | null>(null);
  const queued = useRef(new Map<string, Doc>());
  const revoked = useRef(new Set<string>());
  const setCollection = useCallback((change: (page: DocsPage) => DocsPage) => {
    current.current = change(current.current);
    publish(current.current);
  }, []);
  const cancelLoad = useCallback(() => {
    listing.current?.abort();
    setLoading(false);
  }, []);
  const remove = useCallback(
    (channels: readonly string[]) => {
      if (current.current.docs.some((doc) => channels.includes(doc.channel)))
        cancelLoad();
      for (const channel of channels) {
        revoked.current.add(channel);
        queued.current.delete(channel);
      }
      setCollection((old) => ({
        ...old,
        docs: old.docs.filter((doc) => !channels.includes(doc.channel)),
      }));
    },
    [cancelLoad, setCollection],
  );
  const changed = useCallback(
    (doc: Doc) => {
      if (revoked.current.has(doc.channel)) return;
      const previous = current.current.docs.find(
        (item) => docKey(item) === docKey(doc),
      );
      if (previous?.revision === doc.revision) return;
      if (previous) cancelLoad();
      setCollection((old) => ({
        ...old,
        docs: [doc, ...old.docs.filter((item) => docKey(item) !== docKey(doc))],
      }));
    },
    [cancelLoad, setCollection],
  );
  const load = useCallback(
    async (more = false) => {
      listing.current?.abort();
      if (!more) {
        reading.current?.abort();
        reading.current = null;
        queued.current.clear();
      }
      const controller = new AbortController();
      listing.current = controller;
      setLoading(true);
      setError("");
      try {
        const page = await retryRead(
          async (signal) => {
            const result = await workspace.list(
              more ? current.current.cursor : undefined,
              signal,
            );
            // Discovery does not populate hidden-channel routes. Resolve this
            // page in one batch before retaining or following any content.
            const ids = [...new Set(result.docs.map((doc) => doc.channel))];
            if (ids.length)
              await workspace.session.channels.resolve?.(ids, {
                signal,
                consistency: "strong",
              });
            return result;
          },
          controller.signal,
          // Rosters and reconnects can retire a read while this view is still active.
          cancelledRead,
        );
        controller.signal.throwIfAborted();
        page.docs = page.docs.filter(
          (doc) => !!workspace.session.channels.get?.(doc.channel),
        );
        for (const doc of page.docs) revoked.current.delete(doc.channel);
        if (!more) setNeedsRefresh(false);
        setCollection((old) => ({
          ...page,
          docs: more
            ? [
                ...new Map(
                  [...old.docs, ...page.docs].map((doc) => [docKey(doc), doc]),
                ).values(),
              ]
            : page.docs,
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!more && current.current.docs.length && isTransientFailure(error))
          setNeedsRefresh(true);
        else
          setError(
            cancelledRead(error)
              ? "Loading docs was interrupted."
              : error instanceof Error
                ? error.message
                : "Docs could not be read.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [workspace, setCollection],
  );
  useEffect(() => {
    void load();
    const queue = queued.current;
    return () => {
      listing.current?.abort();
      reading.current?.abort();
      reading.current = null;
      queue.clear();
    };
  }, [load]);
  const channels = [...new Set(collection.docs.map((doc) => doc.channel))]
    .sort()
    .join(":");
  const reconcile = useCallback(async () => {
    if (reading.current || !queued.current.size) return;
    const request = new AbortController();
    reading.current = request;
    const { signal } = request;
    try {
      // Replay can touch every loaded page. Admit one bounded background batch
      // at a time, while coalescing newer hints for addresses still queued.
      while (!signal.aborted && queued.current.size) {
        const batch = [...queued.current.values()].slice(0, 32);
        for (const doc of batch) queued.current.delete(doc.channel);
        const isCurrent = (before: Doc) =>
          !revoked.current.has(before.channel) &&
          !queued.current.has(before.channel) &&
          current.current.docs.some(
            (doc) =>
              docKey(doc) === docKey(before) &&
              doc.revision === before.revision,
          );
        try {
          const heads = new Map(
            (await workspace.reconcile(batch, signal)).map((head) => [
              docKey(head),
              head,
            ]),
          );
          signal.throwIfAborted();
          for (const before of batch) {
            if (!isCurrent(before)) continue;
            const head = heads.get(docKey(before));
            if (head) changed(head);
            else remove([before.channel]);
          }
        } catch (error) {
          if (signal.aborted) return;
          for (const before of batch) {
            if (!isCurrent(before)) continue;
            if (
              (isTransientFailure(error) || cancelledRead(error)) &&
              workspace.session.channels.get?.(before.channel)
            )
              setNeedsRefresh(true);
            else remove([before.channel]);
          }
        }
      }
    } finally {
      if (reading.current === request) reading.current = null;
    }
  }, [workspace, changed, remove]);
  useLayoutEffect(() => {
    if (!channels) return;
    const stop = workspace.session.artifacts.follow(
      channels.split(":"),
      (events) => {
        const known = new Map(
          current.current.docs.map((doc) => [doc.channel, doc]),
        );
        for (const event of events) {
          const artifact = event.kind === DOC_KIND;
          const channel = docTag(event, artifact ? "h" : "d");
          if (!channel || revoked.current.has(channel)) continue;
          const doc = known.get(channel);
          if (
            !doc ||
            (artifact &&
              (doc.revision === event.id || docTag(event, "d") !== doc.id))
          )
            continue;
          queued.current.set(channel, doc);
        }
        queueMicrotask(() => void reconcile());
      },
      remove,
    );
    // Revocation may precede this subscription; follow reports future losses.
    const denied = channels
      .split(":")
      .filter((channel) => !workspace.session.channels.get?.(channel));
    if (denied.length) remove(denied);
    return stop;
  }, [workspace, channels, reconcile, remove]);
  const showRefresh =
    !error &&
    (needsRefresh ||
      (liveInterrupted && (!loading || collection.docs.length > 0)));
  return { collection, loading, error, showRefresh, load, changed, remove };
}

/** Resolve retained titles only when browsing Trash, in batches of exact revision IDs. */
export function useTrashTitles(
  workspace: DocsWorkspace,
  entries: readonly Doc[],
  enabled: boolean,
) {
  const [titles, setTitles] = useState(
    () => new Map<string, string | undefined>(),
  );
  useEffect(() => {
    if (!enabled) return;
    const pending = entries.flatMap((doc) => {
      const parent =
        doc.deleted && !titles.has(doc.revision) && docTag(doc.event, "prev");
      return parent ? [{ doc, parent }] : [];
    });
    if (!pending.length) return;
    const controller = new AbortController();
    const read = async () => {
      const next = new Map(titles);
      for (let offset = 0; offset < pending.length; offset += DOC_PAGE) {
        const batch = pending.slice(offset, offset + DOC_PAGE);
        const events = await workspace.read(
          [
            {
              kinds: [DOC_KIND],
              ids: batch.map(({ parent }) => parent),
              "#h": batch.map(({ doc }) => doc.channel),
              limit: batch.length,
            },
          ],
          controller.signal,
        );
        const byId = new Map(events.map((event) => [event.id, event]));
        for (const { doc, parent } of batch) {
          const event = byId.get(parent);
          const retained = event && parseDoc(event);
          next.set(
            doc.revision,
            retained && !retained.deleted && docKey(retained) === docKey(doc)
              ? retained.title
              : undefined,
          );
        }
      }
      controller.signal.throwIfAborted();
      setTitles(next);
    };
    void read().catch(() => {});
    return () => controller.abort();
  }, [enabled, entries, titles, workspace]);
  return titles;
}

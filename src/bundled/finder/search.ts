import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchMessages } from "../../app/shell/useSearchMessages";
import type { RelaySession } from "../../features/relay/session";
import {
  createCorpus,
  type FinderCorpus,
  type FinderDoc,
  type FinderResults,
} from "./corpus.ts";
import { type ChannelSearchStatus, type FinderSync, finderDoc } from "./sync";

const PAGE = 50;

/** Relay hits held until Finder closes, then added to the index, so the
 * device rows above them never change while you read. */
export function useFinderHeld(sync: FinderSync | undefined, open: boolean) {
  const held = useRef(new Map<string, FinderDoc>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing flushes, so `open` is the trigger, not an input.
  useEffect(
    () => () => {
      sync?.remember([...held.current.values()]);
      held.current.clear();
    },
    [sync, open],
  );
  return (docs: readonly FinderDoc[]) => {
    for (const doc of docs) held.current.set(doc.id, doc);
  };
}

/** Device matches in one channel. With fewer than 20, `sync` reads older
 * pages within the opening's budget; edits and new contents wake it. */
export function useFinderChannel({
  corpus,
  query,
  revision,
  sync,
  channelId,
  opening,
}: {
  corpus: FinderCorpus;
  query: string;
  revision: number;
  sync: FinderSync | undefined;
  channelId: string | undefined;
  opening: object;
}) {
  const typed = useRef(query);
  typed.current = query;
  const reader = useRef<ReturnType<FinderSync["searchChannel"]>>(undefined);
  const [progress, setProgress] = useState<ChannelSearchStatus>();
  useEffect(() => {
    setProgress(undefined);
    if (!sync || !channelId) return;
    const running = sync.searchChannel(
      channelId,
      () => corpus.search(typed.current, 20, channelId).total < 20,
      setProgress,
      opening,
    );
    reader.current = running;
    return () => {
      reader.current = undefined;
      running.dispose();
    };
  }, [sync, channelId, corpus, opening]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: edits and new corpus contents wake the existing reader.
  useEffect(() => {
    reader.current?.wake();
  }, [query, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision names the corpus contents.
  const results = useMemo(
    () => corpus.search(query, 50, channelId),
    [corpus, query, revision, channelId],
  );
  return {
    results,
    progress,
    keepGoing: () => reader.current?.keepGoing(),
  };
}

/** Device matches at once, then the relay's after a pause in typing. The
 * existing message search owns debounce, cancellation and channel access. */
export function useFinderAll({
  session,
  corpus,
  query,
  revision,
  hold,
}: {
  session: RelaySession;
  corpus: FinderCorpus;
  query: string;
  revision: number;
  hold: (docs: readonly FinderDoc[]) => void;
}) {
  // While the relay is asked, and once its rows show, the device rows above
  // hold still until the text changes: the relay's own hits also reach the
  // index as they arrive, and would otherwise move in above.
  const holding = useRef(false);
  const kept = useRef<{
    query: string;
    session: RelaySession;
    results: FinderResults;
  }>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision names the corpus contents.
  const fresh = useMemo(
    () => corpus.search(query, PAGE),
    [corpus, query, revision],
  );
  const local =
    holding.current &&
    kept.current?.query === query &&
    kept.current.session === session
      ? kept.current.results
      : fresh;
  kept.current = { query, session, results: local };
  // Always asked: a page of device rows with every word can still rank below
  // an unindexed message that has them together.
  const search = useSearchMessages(session, query);
  const [previous, setPrevious] = useState<{
    session: RelaySession;
    query: string;
    messages: typeof search.messages;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hook projects a new array each render; IDs identify its completed page.
  useEffect(() => {
    if (!search.loading && !search.error && !search.tooShort) {
      setPrevious({ session, query, messages: search.messages });
    }
  }, [
    session,
    query,
    search.loading,
    search.error,
    search.tooShort,
    search.messages.map((message) => message.id).join(","),
  ]);
  // Only this text's rows stay through a reload or retry; another text's
  // could be opened by mistake while this one loads.
  const messages =
    (search.loading || search.error) &&
    previous?.session === session &&
    previous.query === query
      ? previous.messages
      : search.messages;
  const shown = new Set(local.hits.map(({ doc }) => doc.id));
  const docs = messages
    .filter((message) => {
      const channel = session.channels.get?.(message.channelId);
      return (
        !shown.has(message.id) &&
        channel &&
        !channel.huddle &&
        !channel.metadataPending
      );
    })
    .map(({ id, channelId, authorId, createdAt, text }) =>
      finderDoc(session, { id, channelId, authorId, createdAt, text }),
    );
  // Fresh completed hits join the index when Finder closes; sync keeps
  // public previews out.
  const freshKey = search.messages.map((message) => message.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: each fresh page once, never retained refresh results.
  useEffect(() => {
    if (!search.loading && !search.error) hold(docs);
  }, [session, search.loading, search.error, freshKey]);
  const ranked = createCorpus();
  ranked.add(docs);
  const results = ranked.search(query, docs.length || 1);
  const matched = new Set(results.hits.map(({ doc }) => doc.id));
  const relay: FinderResults = {
    total: docs.length,
    hits: [
      ...results.hits,
      ...docs
        .filter((doc) => !matched.has(doc.id))
        .map((doc) => ({ doc, score: 0, positions: [] })),
    ],
  };
  const asked = !search.tooShort && !!query.trim();
  holding.current = asked && (search.loading || relay.hits.length > 0);
  return { local, relay, search, asked };
}

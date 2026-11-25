import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import { useIdentityNames } from "../../features/identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { avatarMedia } from "../../shared/avatar-source";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { targetKey } from "../../features/navigation/targets";
import {
  docKey,
  docAddress,
  docUrl,
  parseDocUrl,
  type Doc,
  type DocAddress,
} from "./model";
import type { DocsWorkspace } from "./workspace";
import { useDocsCollection, useTrashTitles } from "./collection";
import { docDisplayTitle } from "./DocMetadata";
import type { PageProps } from "../../features/pages/service";
import { useDocsUi } from "./ui";
import type { PanelProps } from "../../features/panels/service";
import {
  useRelayConnection,
  useProfileGeneration,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { NoteIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { DocDocument, type CreatedDoc } from "./DocDocument";
import { NewDocDocument, type NewDraft } from "./NewDocDocument";
import { DocsPage } from "./DocsPage";
import styles from "./WorkingDocs.module.css";
import {
  workingRoute,
  workingTarget,
  type WorkingRoute,
} from "./working-route";

export type DocsOwner = (session: RelaySession) => DocsWorkspace;

function openBuzzLink(
  navigator: Navigation | undefined,
  session: RelaySession,
  url: string,
) {
  const target = buzzLinkTarget(url, {
    viewer: session.viewer ?? "",
    communityOrigin: session.scope.replace(/:[0-9a-f]{64}$/, ""),
  });
  if (!navigator || !target) return false;
  void navigator.open(target);
  return true;
}
export function WorkingDocsPage({
  relay,
  getWorkspace,
  navigator,
  navigation,
  ...props
}: PageProps & {
  relay: RelayData;
  getWorkspace: DocsOwner;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope ||
      connection.status !== "ready" ||
      !connection.viewer ||
      !connection.scope
    )
      return;
    request.resolve({
      ...request.target,
      scope: {
        viewer: connection.viewer,
        communityOrigin: connection.scope.slice(
          0,
          -(connection.viewer.length + 1),
        ),
      },
    });
  }, [request, connection]);
  if (connection.status !== "ready")
    return (
      <Panel aria-label="Docs" aria-busy={connection.status === "connecting"}>
        <PanelHeader
          title={
            <PanelHeaderLabel title="Docs" icon={<NoteIcon size={16} />} />
          }
        />
        {connection.status !== "connecting" && (
          <div className={styles.browser}>
            <p>Connect to your community to open docs.</p>
            {connection.status === "error" && (
              <>
                <p role="alert">{connection.error}</p>
                <Button onClick={() => relay.retry()}>Retry connection</Button>
              </>
            )}
          </div>
        )}
      </Panel>
    );
  const route =
    request?.target.kind === "page"
      ? workingRoute(request.target.route?.params)
      : undefined;
  if (route?.community && route.community !== connection.origin)
    return <p role="status">Connect to this doc’s community to open it.</p>;
  return (
    <WorkingDocsCommunity
      key={`${connection.scope}:${connection.generation}`}
      workspace={getWorkspace(connection.session)}
      relay={relay}
      navigator={navigator}
      navigation={navigation}
      {...props}
    />
  );
}

export function WorkingDocsCommunity({
  workspace,
  relay,
  navigator,
  navigation,
}: PageProps & {
  workspace: DocsWorkspace;
  relay?: RelayData;
  navigator?: Navigation;
}) {
  const request = relay
    ? navigation?.forSession(relay, relay.snapshot())
    : undefined;
  const requestedDestination = useMemo(
    () =>
      request?.target.kind === "page"
        ? workingRoute(request.target.route?.params)
        : undefined,
    [request],
  );
  const presentedDestination = useRef(requestedDestination);
  useLayoutEffect(() => {
    if (request) presentedDestination.current = requestedDestination;
  }, [request, requestedDestination]);
  // The host briefly unbinds navigation between visits. Keep the current
  // document visible so rebinding does not replay its opening focus.
  const destination = request
    ? requestedDestination
    : presentedDestination.current;
  const initial = useMemo(
    () => (destination?.view === "doc" ? docAddress(destination) : undefined),
    [destination],
  );
  const searchRef = useRef<HTMLElement>(null);
  const { collection, loading, error, showRefresh, load, changed, remove } =
    useDocsCollection(workspace);
  const [query, setQuery] = useState(destination?.query ?? "");
  const [trash, setTrash] = useState(destination?.trash ?? false);
  const trashTitles = useTrashTitles(workspace, collection.docs, trash);
  const title = (doc: Doc) =>
    docDisplayTitle(doc, trashTitles.get(doc.revision));
  const { profiles, viewer } = workspace.session;
  const identities = useMemo(
    () => [...new Set(collection.docs.map((doc) => doc.event.pubkey))].sort(),
    [collection.docs],
  );
  const profileMap = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
  );
  const resolveName = useIdentityNames(workspace.session.names);
  const generation = useProfileGeneration(profiles);
  useEffect(() => {
    void generation;
    const release = profiles.reserve?.(identities.length);
    // Use the shared directory's budget and de-duplicated background reads.
    // Missing editor profiles use public-key labels.
    void profiles
      .ensure(identities.slice(0, profiles.limit?.()), "background")
      .catch(() => {});
    return release;
  }, [profiles, identities, generation]);
  const drafts = useRef(new Map<string, NewDraft>());
  const createdDrafts = useRef(new Map<string, DocAddress>());
  const newDocHandoffs = useRef(new Map<string, CreatedDoc>());
  const [opened, setOpened] = useState<DocAddress[]>(() =>
    initial ? [initial] : [],
  );
  const [selected, setSelected] = useState(
    initial ? docKey(initial) : "browse",
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const reveal = useCallback((address: DocAddress) => {
    setOpened((old) =>
      old.some((item) => docKey(item) === docKey(address))
        ? old
        : [...old, { id: address.id, channel: address.channel }],
    );
    setSelected(docKey(address));
  }, []);
  const visit = useCallback(
    (next: WorkingRoute, replace = false) => {
      if (
        !navigator ||
        !request ||
        request.signal.aborted ||
        request.target.kind !== "page" ||
        navigator.snapshot().entry.id !== request.entryId
      )
        return;
      const target = workingTarget(request.target, next);
      if (targetKey(target) === targetKey(navigator.snapshot().entry.target))
        return;
      void navigator.open(target, {
        focus: "preserve",
        replace,
      });
    },
    [navigator, request],
  );
  const open = (address: DocAddress, replace = false) => {
    reveal(address);
    visit(
      {
        view: "doc",
        ...docAddress(address),
        query,
        trash,
      },
      replace,
    );
  };
  const browse = () => {
    setSelected("browse");
    visit({ view: "browse", query, trash });
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const newDoc = (draft: Omit<NewDraft, "id">) => {
    const next = { ...draft, id: crypto.randomUUID() };
    drafts.current.set(next.id, next);
    setSelected(`new:${next.id}`);
    visit({
      view: "new",
      draft: next.id,
      query,
      trash,
    });
  };
  useEffect(() => {
    if (!request || !destination) return;
    if (initial) reveal(initial);
    else setSelected("browse");
    setQuery(destination.query ?? "");
    setTrash(destination.trash ?? false);
    if (destination.view === "new" && destination.draft) {
      const created = createdDrafts.current.get(destination.draft);
      if (created) {
        reveal(created);
        const { draft: _draft, ...rest } = destination;
        visit({ ...rest, view: "doc", ...created }, true);
      } else {
        if (!drafts.current.has(destination.draft))
          drafts.current.set(destination.draft, {
            id: destination.draft,
            title: "",
            markdown: "",
          });
        setSelected(`new:${destination.draft}`);
      }
    }
  }, [request, initial, destination, reveal, visit]);
  const visible = collection.docs.filter((doc) => doc.deleted === trash);
  return (
    <DocsPage
      community={workspace.session.scope.replace(/:[0-9a-f]{64}$/, "")}
      author={(doc) => {
        const key = doc.event.pubkey;
        const profile = profileMap.get(key);
        return {
          name:
            key === viewer
              ? "You"
              : resolveName(key, profile?.name ?? formatPublicKey(key) ?? key),
          picture: avatarMedia(profile?.picture, workspace.session.media),
          isAgent: !!profile?.isAgent,
        };
      }}
      {...{
        selected,
        title,
        query,
        trash,
        searchRef,
        loading,
        showRefresh,
        more: collection.more,
        error,
        search: (value, commit) => {
          setQuery(value);
          if (commit)
            visit({
              ...(destination ?? { view: "browse" }),
              query: value,
              trash,
            });
        },
        openTrash: (value) => {
          setTrash(value);
          setQuery("");
          visit({
            view: "browse",
            trash: value,
          });
          requestAnimationFrame(() => searchRef.current?.focus());
        },
        create: () => newDoc({ title: "", markdown: "" }),
        refresh: () => {
          void load();
        },
        loadMore: () => {
          void load(true);
        },
        browse,
        entries: visible,
        open,
        items: [
          ...opened.map((address) => {
            const key = docKey(address);
            const doc = collection.docs.find((doc) => docKey(doc) === key);
            return {
              id: key,
              label: doc ? title(doc) : "Doc",
              content: (
                <DocDocument
                  address={address}
                  created={newDocHandoffs.current.get(key)}
                  workspace={workspace}
                  active={selected === key}
                  view={
                    selected === key &&
                    destination?.view === "doc" &&
                    initial &&
                    docKey(initial) === key
                      ? destination
                      : undefined
                  }
                  onViewChange={
                    selected === key
                      ? (view) =>
                          visit({
                            view: "doc",
                            ...docAddress(address),
                            query,
                            trash,
                            ...view,
                          })
                      : undefined
                  }
                  onOpen={open}
                  onOpenLink={(url) =>
                    openBuzzLink(navigator, workspace.session, url)
                  }
                  onUnavailable={(missing) => {
                    newDocHandoffs.current.delete(key);
                    remove([missing.channel]);
                  }}
                  onChange={(doc) => {
                    newDocHandoffs.current.delete(key);
                    changed(doc);
                  }}
                />
              ),
            };
          }),
          ...[...drafts.current.values()].map((draft) => ({
            id: `new:${draft.id}`,
            label: "New doc",
            content: (
              <NewDocDocument
                workspace={workspace}
                initial={draft}
                active={selected === `new:${draft.id}`}
                onDraftChange={(next) => drafts.current.set(next.id, next)}
                onCreated={(created) => {
                  const { doc } = created;
                  createdDrafts.current.set(draft.id, docAddress(doc));
                  drafts.current.delete(draft.id);
                  changed(doc);
                  if (selectedRef.current === `new:${draft.id}`) {
                    newDocHandoffs.current.set(docKey(doc), created);
                    open(doc, true);
                  }
                }}
              />
            ),
          })),
        ],
      }}
    />
  );
}

/** The channel owns this tab; linked views retain drafts while moving back. */
export function WorkingDocPanel({
  target,
  relay,
  getWorkspace,
  navigator,
  context,
}: PanelProps & {
  relay: RelayData;
  getWorkspace: DocsOwner;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const initial = useMemo(() => parseDocUrl(target), [target]);
  if (
    !initial ||
    connection.status !== "ready" ||
    initial.community !== connection.origin
  )
    return (
      <div className={styles.browser}>
        <p role="status">Connect to this doc’s community to open it.</p>
      </div>
    );
  return (
    <DocPanelContents
      key={`${connection.scope}:${connection.generation}:${docKey(initial)}`}
      initial={initial}
      workspace={getWorkspace(connection.session)}
      navigator={navigator}
      context={context}
    />
  );
}

function DocPanelContents({
  initial,
  workspace,
  navigator,
  context,
}: {
  initial: DocAddress;
  workspace: DocsWorkspace;
  navigator: Navigation;
  context: PanelProps["context"];
}) {
  const [title, setTitle] = useState("Doc");
  const communityOrigin = workspace.session.scope.replace(/:[0-9a-f]{64}$/, "");
  const viewer = workspace.session.viewer ?? "";
  const openInDocs = useCallback(
    (address: DocAddress) => {
      void navigator.open({
        version: 1,
        kind: "page",
        pluginId: "com.squareup.docs",
        pageId: "docs",
        scope: { viewer, communityOrigin },
        route: {
          version: 1,
          params: { view: "doc", ...docAddress(address) },
        },
      });
    },
    [navigator, viewer, communityOrigin],
  );
  const showInDocs = useCallback(
    () => openInDocs(initial),
    [openInDocs, initial],
  );
  const tabActions = useMemo(
    () => [{ label: "Open in Docs", run: showInDocs }],
    [showInDocs],
  );
  useDocsUi().panels.useTabTitle?.(title, undefined, tabActions);
  const open = (address: DocAddress) => {
    if (!context?.open(docUrl(address, communityOrigin))) openInDocs(address);
  };
  return (
    <div className={styles.page}>
      <DocDocument
        address={initial}
        workspace={workspace}
        onChange={(doc) => setTitle(docDisplayTitle(doc))}
        onUnavailable={() => setTitle("Doc")}
        onOpen={open}
        onOpenInDocs={showInDocs}
        onOpenLink={(url) => openBuzzLink(navigator, workspace.session, url)}
      />
    </div>
  );
}

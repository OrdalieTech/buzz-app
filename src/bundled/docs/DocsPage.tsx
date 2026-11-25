import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { docKey, docUrl, type Doc } from "./model";
import {
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  Filter2Icon,
  NoteIcon,
  PlusIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuCheckboxItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { DocAuthor, DocTime } from "./DocMetadata";
import styles from "./DocsPage.module.css";

export type DocsPageProps = {
  community: string;
  entries: readonly Doc[];
  title(doc: Doc): string;
  author(doc: Doc): Parameters<typeof DocAuthor>[0];
  items: readonly { id: string; label: string; content: ReactNode }[];
  selected: string;
  query: string;
  trash: boolean;
  searchRef: RefObject<HTMLElement | null>;
  loading: boolean;
  showRefresh: boolean;
  more: boolean;
  error: string;
  search(query: string, commit?: boolean): void;
  openTrash(value: boolean): void;
  create(): void;
  refresh(): void;
  loadMore(): void;
  open(doc: Doc): void;
  browse(): void;
};

/** The workspace owns discovery, access, drafts and navigation. This page renders its documents. */
export function DocsPage({
  community,
  entries,
  title,
  author,
  items,
  selected,
  query,
  trash,
  searchRef,
  loading,
  showRefresh,
  more,
  error,
  search,
  openTrash,
  create,
  refresh,
  loadMore,
  open,
  browse,
}: DocsPageProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const reading = selected !== "browse";
  useEffect(() => {
    if (selected !== "browse" && !selected.startsWith("new:"))
      backRef.current?.focus();
  }, [selected]);
  const match = query.toLowerCase();
  const visible = entries
    .filter((doc) =>
      `${title(doc)}\n${doc.markdown}\n${doc.event.pubkey}`
        .toLowerCase()
        .includes(match),
    )
    .sort(
      (a, b) =>
        b.event.created_at - a.event.created_at ||
        a.event.id.localeCompare(b.event.id),
    );
  const empty = !loading && !error && !entries.length && !query;
  const active = items.find((item) => item.id === selected);
  const titleLink = (doc: Doc) => (
    <li key={docKey(doc)}>
      <NavigationItem
        nativeButton={false}
        role="link"
        aria-label={title(doc)}
        aria-description={`Last edited by ${author(doc).name}`}
        render={<a href={docUrl(doc, community)} />}
        label={<span className="text-label">{title(doc)}</span>}
        icon={<NoteIcon size={20} className="text-subtle" aria-hidden="true" />}
        trailing={
          <span className={`${styles.rowMetadata} text-caption text-subtle`}>
            <span title={`Last edited by ${author(doc).name}`}>
              <DocAuthor {...author(doc)} avatarOnly />
            </span>
            <DocTime doc={doc.event} />
          </span>
        }
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          open(doc);
        }}
      />
    </li>
  );
  return (
    <div className={styles.page}>
      <div className={styles.collection} hidden={reading}>
        <Panel aria-label="Docs">
          <div className={styles.page}>
            <PanelHeader
              title={
                <PanelHeaderLabel title="Docs" icon={<NoteIcon size={16} />} />
              }
              actions={
                showRefresh && (
                  <IconButton
                    aria-label="Refresh docs"
                    title="Refresh docs"
                    icon={<ArrowsClockwiseIcon size={16} />}
                    aria-busy={loading}
                    disabled={loading}
                    onClick={refresh}
                  />
                )
              }
            />
            <div className={styles.body}>
              <SearchField
                variant="capsule"
                inputRef={searchRef}
                label={trash ? "Search Trash" : "Search docs"}
                placeholder={trash ? "Search in Trash" : "Search"}
                value={query}
                onValueChange={(value) => search(value)}
                onBlur={() => search(query, true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") search(query, true);
                }}
                prefix={
                  trash && (
                    <Button
                      size="xs"
                      variant="subtle"
                      aria-label="Exit Trash"
                      title="Back to all docs"
                      onClick={() => openTrash(false)}
                    >
                      <span>Trash</span>
                      <XIcon size={12} aria-hidden="true" />
                    </Button>
                  )
                }
                trailing={
                  <MenuRoot>
                    <MenuTrigger
                      render={
                        <IconButton
                          aria-label="Filter docs"
                          title="Filter docs"
                          variant={trash ? "prominent" : "ghost"}
                          icon={<Filter2Icon size={16} aria-hidden="true" />}
                        />
                      }
                    />
                    <MenuPopup align="end">
                      <MenuCheckboxItem
                        checked={trash}
                        onCheckedChange={openTrash}
                        closeOnClick
                      >
                        Show Trash
                      </MenuCheckboxItem>
                    </MenuPopup>
                  </MenuRoot>
                }
              />
              {error && (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="alert" className="m-0">
                    {error}
                  </p>
                  <Button size="sm" variant="subtle" onClick={refresh}>
                    Try again
                  </Button>
                </div>
              )}
              <LoadingRegion
                pending={loading}
                statusVisibility={
                  loading && !entries.length ? "visible" : "screen-reader"
                }
                label={
                  <span className="inline-flex items-center gap-2">
                    <TypingDots size="small" />
                    Loading docs…
                  </span>
                }
              >
                {empty ? (
                  <EmptyState
                    icon={null}
                    title={trash ? "Trash is empty" : "No docs yet"}
                    description={
                      trash
                        ? undefined
                        : "Create a doc or ask an agent to save one."
                    }
                    action={
                      !trash && (
                        <Button variant="subtle" onClick={create}>
                          <PlusIcon size={16} aria-hidden="true" />
                          New doc
                        </Button>
                      )
                    }
                  />
                ) : (
                  <ul
                    className={styles.titleList}
                    aria-label={trash ? "Trash" : "Docs"}
                  >
                    {!trash && (
                      <li key="new-page">
                        <NavigationItem
                          variant="text"
                          icon={<PlusIcon size={16} aria-hidden="true" />}
                          label="New doc"
                          onClick={create}
                        />
                      </li>
                    )}
                    {visible.map(titleLink)}
                  </ul>
                )}
              </LoadingRegion>
              {!loading && !error && query && !visible.length && (
                <p className={styles.noMatches} role="status">
                  {trash ? "No matching docs in Trash." : "No matching docs."}
                </p>
              )}
              {more && (
                <div>
                  <Button size="sm" loading={loading} onClick={loadMore}>
                    Load more docs
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>
      <div className={styles.fullView} hidden={!reading}>
        <Panel aria-label="Doc details">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title={active?.label ?? "Doc"}
                icon={<NoteIcon size={16} />}
              />
            }
            navigation={
              <IconButton
                ref={backRef}
                aria-label="Back to docs"
                title="Back to docs"
                icon={<CaretLeftIcon size={16} />}
                onClick={browse}
              />
            }
          />
          {items.map((item) => (
            <div
              key={item.id}
              className={styles.docView}
              hidden={item.id !== selected}
            >
              {item.content}
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

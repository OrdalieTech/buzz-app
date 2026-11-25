import { viewerMember } from "../../features/relay/membership";
// Who Share sends an agent to: people by direct message, or a channel the
// viewer belongs to, found with one search as Share access does.
import { useSyncExternalStore, type Ref } from "react";
import { usePeople } from "../../features/direct-messages/usePeople";
import type { RelaySession } from "../../features/relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { SEARCH_MIN_CHARS } from "../../shared/search-debounce";
import { CheckIcon, HashIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import styles from "./AgentShareDialog.module.css";

export type ShareTarget =
  | { kind: "person"; id: string; name: string; picture?: string | undefined }
  | { kind: "channel"; id: string; name: string };

/** A target as a sentence names it: "Bea" or "#design". */
export const targetName = (target: ShareTarget) =>
  target.kind === "channel" ? `#${target.name}` : target.name;

// The directory is unbounded; browsing offers a few, searching narrows it.
const BROWSE_PEOPLE = 8;

export function AgentShareRecipients({
  session,
  query,
  chosen,
  disabled,
  inputRef,
  onQueryChange,
  onChange,
}: {
  session: RelaySession;
  query: string;
  chosen: readonly ShareTarget[];
  disabled: boolean;
  inputRef: Ref<HTMLElement>;
  onQueryChange(query: string): void;
  onChange(targets: ShareTarget[]): void;
}) {
  const directory = usePeople(session, query);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const picked = new Set(chosen.map((target) => target.id));
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  const people: ShareTarget[] = directory.people
    .filter(
      (person) =>
        !person.isAgent &&
        person.pubkey !== session.viewer &&
        !picked.has(person.pubkey),
    )
    .slice(0, needle ? undefined : BROWSE_PEOPLE)
    .map((person) => ({
      kind: "person",
      id: person.pubkey,
      name: person.name,
      picture: person.picture,
    }));
  // Channels the viewer can post in, as Share access offers them.
  const channels: ShareTarget[] = list.channels
    .filter(
      (item) =>
        !item.huddle &&
        !item.metadataPending &&
        !item.readOnly &&
        !item.cached &&
        !item.archived &&
        ["stream", "forum"].includes(item.channelType ?? "") &&
        viewerMember(item, session.viewer) &&
        !picked.has(item.id) &&
        item.name.toLowerCase().includes(needle),
    )
    .map((item) => ({ kind: "channel", id: item.id, name: item.name }));
  const row = (target: ShareTarget, isChosen: boolean) => (
    <li key={target.id}>
      <NavigationItem
        variant="option"
        aria-current={false}
        aria-pressed={isChosen}
        disabled={disabled}
        onClick={() =>
          onChange(
            isChosen
              ? chosen.filter((item) => item.id !== target.id)
              : [...chosen, target],
          )
        }
        icon={
          target.kind === "channel" ? (
            <HashIcon size={24} aria-hidden="true" />
          ) : (
            <Avatar
              alt=""
              fallback={target.name}
              src={avatarMedia(target.picture, session.media)}
              size="small"
            />
          )
        }
        label={targetName(target)}
        trailing={isChosen && <CheckIcon size={16} aria-hidden="true" />}
      />
    </li>
  );
  const group = (title: string, targets: ShareTarget[], isChosen = false) =>
    targets.length > 0 && (
      <section aria-label={title}>
        <h3 className={`${styles.groupHeading} text-caption text-subtle`}>
          {title}
        </h3>
        <ul>{targets.map((target) => row(target, isChosen))}</ul>
      </section>
    );
  return (
    <>
      <SearchField
        inputRef={inputRef}
        label="Search people and channels"
        placeholder="Send to people or a channel"
        value={query}
        disabled={disabled}
        onValueChange={onQueryChange}
        maxLength={256}
      />
      <div className={`${styles.results} buzz-thin-scrollbar`}>
        {group(`Sending to · ${chosen.length}`, [...chosen], true)}
        {group("People", people)}
        {group("Channels", channels)}
        {directory.loading && !people.length ? (
          <p
            role="status"
            className={`${styles.note} text-body-sm text-subtle`}
          >
            {needle ? "Searching…" : "Loading people…"}
          </p>
        ) : (
          !people.length &&
          !channels.length && (
            <p className={`${styles.note} text-body-sm text-subtle`}>
              {directory.tooShort
                ? `Type at least ${SEARCH_MIN_CHARS} characters to search people.`
                : needle
                  ? "No people or channels match your search."
                  : "No one else to send to yet."}
            </p>
          )
        )}
        {directory.error && (
          <p role="alert" className={`${styles.note} text-body-sm text-danger`}>
            {directory.error}
          </p>
        )}
      </div>
    </>
  );
}

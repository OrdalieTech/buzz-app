import type { Navigation } from "../../features/navigation/controller";
import { useChannelList } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { channelIcon } from "../../features/channels/channel-icon";
import styles from "./Profiles.module.css";

/** Only the viewer's listed channels with an exact roster match are evidence. */
export function ProfileChannels({
  session,
  pubkey,
  communityOrigin,
  viewer,
  navigation,
}: {
  session: RelaySession;
  pubkey: string;
  communityOrigin: string | undefined;
  viewer: string | undefined;
  navigation: Navigation | undefined;
}) {
  const list = useChannelList(session.channels);
  const channels = (
    list.status === "ready" || list.status === "error" ? list.channels : []
  ).filter(
    (channel) =>
      !channel.huddle &&
      !channel.metadataPending &&
      !channel.archived &&
      !channel.hidden &&
      (channel.channelType === "stream" || channel.channelType === "forum") &&
      channel.members?.includes(pubkey),
  );
  const unclassifiedMembership =
    (list.status === "ready" || list.status === "error") &&
    list.channels.some(
      (channel) =>
        !channel.huddle &&
        !channel.archived &&
        !channel.hidden &&
        !channel.channelType &&
        channel.members?.includes(pubkey),
    );
  return (
    <section aria-label="Channels" className="flex flex-col gap-2">
      <div className={styles.channelList}>
        {(list.status === "idle" || list.status === "loading") && (
          <p className={styles.channelNote} role="status">
            Loading channels…
          </p>
        )}
        {list.status === "unavailable" && (
          <p className={styles.channelNote}>
            Channel membership is unavailable.
          </p>
        )}
        {list.status === "error" && (
          <div className={styles.channelNote}>
            <p role="alert">Could not finish loading channels.</p>
            <Button
              size="compact"
              onClick={() => session.channels.refreshList?.()}
            >
              Retry channels
            </Button>
          </div>
        )}
        {unclassifiedMembership && (
          <p
            className={`${styles.channelNote} m-0 text-body-sm text-secondary`}
          >
            Some memberships for this identity are unclassified and omitted.
          </p>
        )}
        {list.status === "ready" && !channels.length && (
          <p className={styles.channelNote}>
            {unclassifiedMembership
              ? `No matching channels with a known visible type; other memberships could not be classified.${list.coverage === "partial" ? " More channels may exist outside the loaded list." : ""}`
              : list.coverage === "partial"
                ? "No matching channels in the loaded list; more channels may exist."
                : "No channels found."}
          </p>
        )}
        {!!channels.length && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {channels.map((channel) => {
              const Icon = channelIcon(channel);
              return (
                <li key={channel.id}>
                  {communityOrigin && navigation && viewer ? (
                    <NavigationItem
                      label={channel.name}
                      icon={<Icon size={20} aria-hidden="true" />}
                      onClick={() =>
                        void navigation.open({
                          version: 1,
                          kind: "conversation",
                          channelId: channel.id,
                          scope: { viewer, communityOrigin },
                        })
                      }
                    />
                  ) : (
                    <span>{channel.name}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {list.coverage === "partial" && !!channels.length && (
        <p className="text-body-sm text-secondary">
          More channels may exist outside the loaded list.
        </p>
      )}
      {channels.length > 0 && (!communityOrigin || !navigation) && (
        <p className="text-body-sm text-secondary">
          Channel navigation is unavailable here.
        </p>
      )}
    </section>
  );
}

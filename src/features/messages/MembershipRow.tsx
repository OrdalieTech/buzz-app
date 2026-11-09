import type { IdentityNameView } from "../identity-names/service";
import { useIdentityNames } from "../identity-names/react";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import referenceStyles from "../../shared/InlineReference.module.css";
import { Fragment, memo } from "react";
import { profileTarget } from "../profiles/target";
import type { Profile } from "../relay/contracts";
import { membershipDescription, type TimelineRow } from "./membership-rows";
import { DayDivider } from "./MessageTimestamp";
import styles from "./Messages.module.css";
import { avatarMedia } from "../../shared/avatar-source";

/** Quiet, non-conversational activity. Avatars are decorative; prose owns the
 * label, and each named member opens their profile like a prose mention. */
export const MembershipRow = memo(function MembershipRow({
  row,
  names,
  profiles,
  viewer,
  media,
  agentPubkeys,
  day,
  resolveName: scopedName,
  onOpenLink,
  canOpenLink,
}: {
  row: TimelineRow;
  names?: IdentityNameView | undefined;
  profiles: ReadonlyMap<string, Profile>;
  viewer?: string | undefined;
  media(url: string, size?: "small"): string | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  day: boolean;
  resolveName?: (pubkey: string, fallback: string) => string;
  onOpenLink?: ((url: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
}) {
  const globalName = useIdentityNames(names);
  const resolveName = scopedName ?? globalName;
  const { targets, parts, title } = membershipDescription(
    row.membershipRows ?? [row],
    profiles,
    viewer,
    resolveName,
  );
  return (
    <div data-message-id={row.id} data-membership-row="">
      {day && <DayDivider createdAt={row.createdAt} />}
      <div className={styles.membership} data-highlight-surface="">
        <span className={styles.membershipAvatars} aria-hidden="true">
          {targets.slice(0, 3).map((id) => {
            const profile = profiles.get(id);
            const name = resolveName(id, profile?.name ?? id.slice(0, 10));
            const picture = avatarMedia(profile?.picture, media);
            return (
              <span
                className={styles.membershipAvatar}
                data-avatar-shape={
                  agentPubkeys?.has(id) ? "squircle" : "circle"
                }
                key={id}
              >
                <Avatar
                  src={picture}
                  alt=""
                  fallback={name}
                  size="fill"
                  shape={agentPubkeys?.has(id) ? "squircle" : "circle"}
                />
              </span>
            );
          })}
          {targets.length > 3 && (
            <span className={styles.membershipAvatarCount}>
              +{targets.length - 3}
            </span>
          )}
        </span>
        <p title={title}>
          {parts.map((part, index) => {
            const key = `${index}:${part.id ?? ""}:${part.text}`;
            if (part.preview) {
              const { label, members } = part.preview;
              return (
                <PopoverRoot key={key}>
                  <PopoverTrigger
                    openOnHover="preview"
                    render={
                      <button
                        type="button"
                        title=""
                        className={`${referenceStyles.link} ${styles.membershipName}`}
                      >
                        {part.text}
                      </button>
                    }
                  />
                  <PopoverPopup side="top" align="center" size="compact">
                    <PopoverTitle>
                      {label} ({members.length})
                    </PopoverTitle>
                    <section
                      className={styles.membershipPeople}
                      aria-label={label}
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded member list needs keyboard focus for native scrolling.
                      tabIndex={0}
                    >
                      <ul>
                        {members.map((member) => (
                          <li key={member.id}>{member.name}</li>
                        ))}
                      </ul>
                    </section>
                  </PopoverPopup>
                </PopoverRoot>
              );
            }
            const agent = !!part.id && !!agentPubkeys?.has(part.id);
            const target = part.id && profileTarget(part.id, { agent });
            if (!target || !canOpenLink?.(target))
              return <Fragment key={key}>{part.text}</Fragment>;
            // A system notice names people as quiet text, not mention chips.
            // No profile target, so copies stay plain prose.
            return (
              <button
                key={key}
                type="button"
                className={`${referenceStyles.link} ${styles.membershipName}`}
                aria-label={
                  part.id === viewer
                    ? "View your profile"
                    : `View ${part.text} profile`
                }
                onClick={(event) => {
                  // WebKit skips focusing buttons on pointer click, so the
                  // profile tab's close would have no origin to return to.
                  event.currentTarget.focus();
                  onOpenLink?.(target);
                }}
              >
                {part.text}
              </button>
            );
          })}
        </p>
      </div>
    </div>
  );
});

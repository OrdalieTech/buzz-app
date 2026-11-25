import type { Doc, DocEvent } from "./model";
import type { ComponentProps } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./DocsPage.module.css";

export function docDisplayTitle(doc: Doc, retainedTitle?: string) {
  if (!doc.deleted) return doc.title;
  return retainedTitle ? `${retainedTitle} (in Trash)` : "Doc in Trash";
}

export function DocBylinePlaceholder() {
  return (
    <div className={styles.byline} aria-hidden="true">
      <Avatar
        alt=""
        fallback=""
        fallbackContent=""
        size="compact"
        shape="squircle"
      />
      <span className="h-2 w-12 rounded-full bg-affordance-disabled" />
      <span className="h-2 w-24 rounded-full bg-affordance-disabled" />
    </div>
  );
}

export function DocByline({
  doc,
  author,
  picture,
  status,
  isAgent = false,
}: {
  doc: DocEvent;
  author: string;
  picture?: string | undefined;
  status?: string | undefined;
  isAgent?: boolean;
}) {
  return (
    <p className={`${styles.byline} text-caption text-secondary`}>
      <DocAuthor name={author} picture={picture} isAgent={isAgent} /> ·
      <span role={status ? "status" : undefined}>
        {status && status !== "Saved" && status !== "Moved to Trash" ? (
          status
        ) : (
          <>
            {status || "Saved"} <DocTime doc={doc} />
          </>
        )}
      </span>
    </p>
  );
}

export function DocTime({ doc }: { doc: Pick<DocEvent, "created_at"> }) {
  const date = new Date(doc.created_at * 1000);
  const days = Math.floor((Date.now() / 1000 - doc.created_at) / 86400);
  // The shared recency ladder switches to calendar dates after a week; docs
  // keep older timestamps relative too, with the exact date in the title.
  const label =
    days >= 7
      ? new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(
          -days,
          "day",
        )
      : relativeTimestamp(doc.created_at);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      })}
    >
      {label}
    </time>
  );
}

export function DocAuthor({
  name,
  picture,
  isAgent,
  avatarOnly = false,
  size = "compact",
}: {
  name: string;
  picture?: string | undefined;
  isAgent: boolean;
  avatarOnly?: boolean;
  size?: ComponentProps<typeof Avatar>["size"];
}) {
  return (
    <span className={styles.byline}>
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size={size}
        shape={isAgent ? "squircle" : "circle"}
      />
      <span className={avatarOnly ? "sr-only" : undefined}>{name}</span>
    </span>
  );
}

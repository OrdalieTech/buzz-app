import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageLink } from "../conversation/MessageLink";
import { parseBuzzLink } from "../navigation/buzz-links";
import { safeLinkUrl } from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import { labelText } from "./label-text";

/** The remark plugins `SafeMarkdown` renders with; guards parse with the same. */
export const safeMarkdownPlugins = [remarkGfm];

/**
 * A Markdown document with the link and image trust rules shared by Notes and
 * Canvas: no raw HTML, images shown as their alt text, and only Buzz or safe
 * links, opened through `MessageLink`.
 */
export function SafeMarkdown({
  content,
  openLink,
  session,
}: {
  content: string;
  openLink(url: string): boolean;
  /** Lets links show what they point to in this session. */
  session?: RelaySession | undefined;
}) {
  return (
    <Markdown
      remarkPlugins={safeMarkdownPlugins}
      urlTransform={(url) =>
        parseBuzzLink(url) ? url : (safeLinkUrl(url) ?? null)
      }
      components={{
        img: ({ alt }) => alt ?? null,
        a: ({ children, href }) => {
          if (!href) return children;
          // A raw autolink shows its destination's name, as in messages.
          const label = labelText(children);
          const raw = label === href;
          return (
            <MessageLink
              url={href}
              label={raw ? undefined : label}
              registry={undefined}
              session={session}
              onOpenLink={openLink}
            >
              {raw ? undefined : children}
            </MessageLink>
          );
        },
      }}
    >
      {content}
    </Markdown>
  );
}

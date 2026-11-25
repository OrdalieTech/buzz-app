import type { RelaySession } from "../../features/relay/session";
import { parseDocUrl, type DocAddress } from "./model";
import { useDocsUi } from "./ui";
import readerStyles from "./DocsPage.module.css";

export function DocMarkdown({
  text,
  community,
  onOpen,
  session,
  openLink,
}: {
  text: string;
  community: string;
  onOpen(address: DocAddress): void;
  session?: RelaySession | undefined;
  openLink?: ((url: string) => boolean) | undefined;
}) {
  const SafeMarkdown = useDocsUi().conversation.Markdown;
  return (
    <div className={readerStyles.markdown}>
      <SafeMarkdown
        content={text}
        scale="document"
        session={session}
        openLink={(url) => {
          const doc = parseDocUrl(url);
          if (doc?.community === community) {
            onOpen(doc);
            return true;
          }
          return openLink?.(url) ?? false;
        }}
      />
    </div>
  );
}

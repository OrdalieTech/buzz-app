import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type {
  AttachmentRenderer,
  AttachmentRendererProps,
  ContributionReader,
  TargetOpener,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { WithTargetOpener } from "./opener";
import { resolveMatch } from "../../plugins/contributions";

export function AttachmentView({
  registry,
  fallback,
  ...props
}: Omit<AttachmentRendererProps, keyof TargetOpener> & {
  registry: ContributionReader<AttachmentRenderer>;
  fallback: ReactNode;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const entry = resolveMatch(entries, props.attachment);
  if (!entry) return fallback;
  return (
    <ContributionBoundary key={contributionKey(entry)} fallback={fallback}>
      <WithTargetOpener
        component={entry.component}
        props={props}
        registry={registry}
        entry={entry}
      />
    </ContributionBoundary>
  );
}

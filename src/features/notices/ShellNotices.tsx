import { useSyncExternalStore } from "react";
import type { PluginManager } from "../../plugins/manager";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { NoticesService } from "./service";

/** Plugins' notices, one toast each, in the order they were shown, each
 * saying which plugin shows it. The person can always dismiss one; an action
 * button closes it with that answer. */
export function ShellNotices({
  notices,
  plugins,
}: {
  notices: NoticesService;
  /** Display names come from the catalog. */
  plugins: Pick<PluginManager, "subscribe" | "snapshot">;
}) {
  const shown = useSyncExternalStore(notices.subscribe, notices.snapshot);
  const { configuration } = useSyncExternalStore(
    plugins.subscribe,
    plugins.snapshot,
  );
  const name = (id: string) =>
    (configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === id,
        )?.manifest.name
      : undefined) ?? id;
  return shown.map((notice) => (
    <ToastNotice
      key={notice.key}
      title={notice.title}
      {...(notice.description ? { description: notice.description } : {})}
      details={
        <div className="text-caption text-subtle">
          From {name(notice.plugin)}
        </div>
      }
      tone="info"
      onDismiss={notice.dismiss}
      reachableOverModal={!!notice.actions?.length}
    >
      {notice.actions?.length
        ? notice.actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              size="sm"
              {...(action.prominent ? { variant: "prominent" as const } : {})}
              onClick={() => notice.pick(action.id)}
            >
              {action.label}
            </Button>
          ))
        : undefined}
    </ToastNotice>
  ));
}

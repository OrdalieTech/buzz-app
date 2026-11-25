import { useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";

export function useLiveUpdatesInterrupted(
  live: RelaySession["live"],
  follows: (channel: string) => boolean,
) {
  return useSyncExternalStore(live.subscribe, () => {
    const { status, routes } = live.snapshot();
    return (
      status === "retrying" ||
      status === "error" ||
      status === "unavailable" ||
      routes.some(
        (route) =>
          (route.status === "error" || route.status === "limited") &&
          !!route.channelId &&
          follows(route.channelId),
      )
    );
  });
}

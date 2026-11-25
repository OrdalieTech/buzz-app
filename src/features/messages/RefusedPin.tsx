import { useEffect } from "react";
import type { OutgoingEvent } from "../relay/outbox";
import { pinLists, refusedPinCommand, type PinSource } from "../relay/pins";

/** Shown in place of Retry for a refused pin command (`refusedPinCommand`).
 * It reads the channel's list again, if any view keeps that list, so pins
 * show as the relay holds them. */
export function RefusedPin({
  source,
  item,
}: {
  source: PinSource | undefined;
  item: Pick<OutgoingEvent, "event" | "error">;
}) {
  const channel = item.event.tags.find(([name]) => name === "h")?.[1];
  useEffect(() => {
    if (source && channel) pinLists(source).retry(channel);
  }, [source, channel]);
  return <span>{refusedPinCommand(item)}</span>;
}

import {
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import type { Outbox, OutboxRecovery, OutgoingEvent } from "../relay/outbox";
import { soloAdminSetup } from "../relay/solo-admins";
import styles from "./AdminSetupRecovery.module.css";

export type AbandonableSetup = { id: string; recovery: OutboxRecovery };

/** Only a created chat's setup can be abandoned. */
export function abandonableSetup(item: OutgoingEvent) {
  return item.delivery === "accepted" || item.delivery === "seen"
    ? soloAdminSetup(item)?.recovery
    : undefined;
}

export function AbandonAdminSetupDialog({
  outbox,
  setup,
  finalFocus,
  onClose,
}: {
  outbox: Pick<Outbox, "dismiss">;
  setup: AbandonableSetup;
  finalFocus: ComponentProps<typeof AlertDialog>["finalFocus"];
  onClose: () => void;
}) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title="Abandon admin setup?"
      description="The chat keeps its current roles. Retry your opening message to continue, or send a new message if it expired."
      initialFocus={cancel}
      finalFocus={finalFocus}
      pending={pending}
      onClose={onClose}
      actions={
        <>
          <Button ref={cancel} disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(undefined);
              try {
                await outbox.dismiss(setup.id, setup.recovery);
                onClose();
              } catch (reason) {
                setError(String(reason));
              } finally {
                setPending(false);
              }
            }}
          >
            Abandon admin setup
          </Button>
        </>
      }
    >
      {error && <p role="alert">{error}</p>}
    </AlertDialog>
  );
}

const channelOf = (item: OutgoingEvent) =>
  item.event.tags.find(([tag]) => tag === "h")?.[1];

/** Offers abandonment in the chat whose opening message setup is blocking,
 * including while a Retry of that message waits on setup. */
export function AdminSetupRecovery({
  outbox,
  channelId,
}: {
  outbox: Pick<Outbox, "subscribe" | "snapshot" | "dismiss">;
  channelId: string;
}) {
  const items = useSyncExternalStore(
    outbox.subscribe,
    outbox.snapshot,
    outbox.snapshot,
  ).filter((item) => channelOf(item) === channelId);
  const [abandoning, setAbandoning] = useState<AbandonableSetup>();
  const [stalled, setStalled] = useState<string>();
  const setup = items.flatMap((item) => {
    const recovery = abandonableSetup(item);
    return recovery ? [{ id: item.event.id, recovery }] : [];
  })[0];
  const blocked = items.some(
    (item) =>
      item.event.kind === 9 &&
      (item.delivery === "failed" || item.delivery === "unknown"),
  );
  if (setup && blocked && stalled !== setup.id) setStalled(setup.id);
  if (!setup || (!blocked && stalled !== setup.id)) return null;
  return (
    <section
      role="status"
      aria-label="Chat admin setup didn’t finish"
      className={styles.recovery}
    >
      <div className={styles.message}>
        <p className="text-label-sm text-warning">
          Chat admin setup didn’t finish
        </p>
        <p className="text-body-sm text-subtle">
          Retry your opening message, or abandon setup to keep the chat’s
          current roles.
        </p>
      </div>
      <Button type="button" size="sm" onClick={() => setAbandoning(setup)}>
        Abandon admin setup
      </Button>
      {abandoning && (
        <AbandonAdminSetupDialog
          outbox={outbox}
          setup={abandoning}
          finalFocus
          onClose={() => setAbandoning(undefined)}
        />
      )}
    </section>
  );
}

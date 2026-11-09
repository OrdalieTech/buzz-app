import type { Agent } from "../../features/agents/service";
import { relayOrigin } from "../../features/communities/destination";
import { relayPartition } from "../../features/relay/partition";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { savedAgentStore } from "../../features/solo/default-agent";

/** The saved Bestie in the connected community, across reconnections.
 * `known`: the account's choice was read. `recorded`: the account holds a
 * record, so known without a Bestie, it saved none rather than never chose. */
export function savedBestie(relay: RelayData) {
  let current:
    | Readonly<{
        snapshot: RelaySnapshot;
        store: ReturnType<typeof savedAgentStore>;
      }>
    | undefined;
  const store = () => {
    const snapshot = relay.snapshot();
    if (
      current?.snapshot.session !== snapshot.session ||
      current.snapshot.scope !== snapshot.scope
    )
      current = {
        snapshot,
        store: savedAgentStore(snapshot.session, snapshot.scope ?? ""),
      };
    return current.store;
  };
  const state = (store: ReturnType<typeof savedAgentStore>) =>
    `${store.snapshot()} ${store.known()} ${store.recorded()}`;
  return {
    snapshot: () => store().snapshot(),
    known: () => store().known(),
    recorded: () => store().recorded(),
    subscribe(listener: () => void) {
      // The saved choice's sources also change for unrelated view state, so
      // only a different Bestie, or community, or its becoming known, is
      // passed on.
      let following = store();
      let last = state(following);
      const changed = () => {
        const next = state(following);
        if (next === last) return;
        last = next;
        listener();
      };
      let stop = following.subscribe(changed);
      const stopRelay = relay.subscribe(() => {
        if (store() === following) return;
        stop();
        following = store();
        last = state(following);
        stop = following.subscribe(changed);
        listener();
      });
      return () => {
        stopRelay();
        stop();
      };
    },
  };
}

export function inCommunity(agent: Agent, { scope }: RelaySnapshot) {
  try {
    return relayPartition(relayOrigin(agent.relay), agent.owner) === scope;
  } catch {
    return false;
  }
}

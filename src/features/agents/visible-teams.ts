import type { Agents } from "./service";
import { communityDestination } from "../communities/destination";

/** The same team inventory in Your teams and the composer's community. */
export function visibleTeams(
  agents: Pick<Agents, "snapshot" | "memberships" | "teamHere">,
  community?: string,
) {
  const snapshot = agents.snapshot();
  const members = new Set(
    snapshot.agents
      .filter((agent) => {
        if (!community) return true;
        try {
          return communityDestination(agent.relay).url === community;
        } catch {
          return false;
        }
      })
      .map((agent) => agent.pubkey),
  );
  return snapshot.teams.filter(
    (team) =>
      team.members.some(
        (pubkey) =>
          members.has(pubkey) ||
          (!!community &&
            agents
              .memberships(pubkey)
              .some(({ origin }) => origin === community)),
      ) ||
      (team.revision
        ? !team.members.length || agents.teamHere({ id: team.id }, community)
        : !team.members.some((pubkey) => agents.memberships(pubkey).length)),
  );
}

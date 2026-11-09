// The turns a remote agent published to its owner over the relay this session.
import {
  type ComponentType,
  type ReactNode,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useRelayConnection } from "../../../features/relay/react";
import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import {
  activityTranscript,
  type TranscriptTurn,
} from "../../../features/agents/activity-transcript";
import { ActivityTranscript } from "../../../features/agents/ActivityTranscript";
import type { Agent, AgentViewProps } from "../../../features/agents/service";
import { SettingsSectionLink } from "../../../features/navigation/SettingsSectionLink";
import type { IdentityNameView } from "../../../features/identity-names/service";
import { useIdentityNames } from "../../../features/identity-names/react";

export type AgentActivity = RelaySession["agentActivity"];

const UNAVAILABLE = "Activity isn't available here.";

export function createActivityTab(
  relay: RelayData,
  openSettings?: (section: string) => void,
): ComponentType<AgentViewProps> {
  return function PublishedActivity({ agent, openConversation }) {
    const connection = useRelayConnection(relay);
    return (
      <ActivityPanel
        agent={agent}
        openConversation={openConversation}
        activity={
          connection.status === "ready"
            ? connection.session.agentActivity
            : undefined
        }
        openSettings={openSettings}
        names={
          connection.status === "ready" ? connection.session.names : undefined
        }
      />
    );
  };
}

export function ActivityPanel({
  agent,
  activity,
  openSettings,
  openConversation,
  names,
}: {
  agent: Agent;
  /** Absent while the owner's session connects. */
  activity: AgentActivity | undefined;
  openSettings?: ((section: string) => void) | undefined;
  openConversation?: AgentViewProps["openConversation"];
  /** Names the people whose messages prompted the turns. */
  names?: IdentityNameView | undefined;
}) {
  if (!activity) return <Note>Activity shows once Buzz is connected.</Note>;
  return (
    <ActivityFeed
      agent={agent}
      openConversation={openConversation}
      activity={activity}
      openSettings={openSettings}
      names={names}
    />
  );
}

// Hosted frames don't always name their thread, so turns aren't scoped to the
// conversation the agent was opened from.
function ActivityFeed({
  agent,
  activity,
  openSettings,
  openConversation,
  names,
}: {
  agent: Agent;
  activity: AgentActivity;
  openSettings: ((section: string) => void) | undefined;
  openConversation: AgentViewProps["openConversation"];
  names: IdentityNameView | undefined;
}) {
  const resolve = useIdentityNames(names);
  // The Agent Activity plugin owns the feed's lease; this only reads it.
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const transcript = useMemo(() => {
    const transcript = activityTranscript(
      snapshot.records.filter((record) => record.agent === agent.pubkey),
      { agent: agent.pubkey },
      (pubkey) => resolve(pubkey, "") || undefined,
    );
    return {
      turns: transcript.turns.map((turn): TranscriptTurn => {
        const retained = snapshot.turns.find(
          (row) => row.agent === agent.pubkey && row.turnId === turn.turnId,
        );
        return retained?.outcome
          ? { ...turn, outcome: retained.outcome }
          : turn;
      }),
    };
  }, [snapshot.records, snapshot.turns, agent.pubkey, resolve]);
  if (snapshot.status === "unavailable") return <Note>{UNAVAILABLE}</Note>;
  if (snapshot.status === "disabled")
    return (
      <Note>
        Turn on Agent Activity in{" "}
        <SettingsSectionLink section="plugins" open={openSettings}>
          Manage plugins
        </SettingsSectionLink>{" "}
        to see activity.
      </Note>
    );
  if (!transcript.turns.length && snapshot.status === "connecting")
    return <Note>Connecting to the live feed…</Note>;
  const state = new Map(
    snapshot.turns
      .filter((turn) => turn.agent === agent.pubkey)
      .map((turn) => [turn.turnId, turn.state]),
  );
  return (
    <ActivityTranscript
      transcript={transcript}
      agentName={agent.name}
      agentKey={agent.key}
      agentPicture={agent.picture}
      community={agent.relay}
      state={(turnId) => state.get(turnId)}
      follow={false}
      openConversation={openConversation}
      before={
        <>
          <Note>
            Turns from all of this agent's conversations, captured while Buzz
            has been open. Earlier turns aren't shown.
          </Note>
          {snapshot.status === "interrupted" && (
            <Note>
              The live feed was interrupted; it reconnects on its own.
            </Note>
          )}
          {snapshot.trimmed > 0 && (
            <Note>Older activity was dropped to save memory.</Note>
          )}
        </>
      }
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-body-sm text-secondary">
      {children}
    </p>
  );
}

import { Button } from "../../shared/design-system/ui/Button";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { EventData } from "../relay/events";
import type { ComposerTool, ContributionReader } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { messageViewKey } from "../messages/view-key";
import type { Outbox, OutgoingEvent } from "../relay/outbox";

const toolOrder = (tool: ComposerTool) =>
  Number.isFinite(tool.order) ? (tool.order ?? 0) : 0;
export function selectReactionTool(
  tools: readonly Contribution<ComposerTool>[],
) {
  return tools
    .filter((tool) => tool.reactionComponent)
    .sort(
      (a, b) =>
        toolOrder(a) - toolOrder(b) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )[0];
}

export function ReactionTool({
  registry,
  ...props
}: {
  registry: ContributionReader<ComposerTool>;
  session: RelaySession;
  scope: string;
  messageId: string;
  disabled: boolean;
  select?: (emoji: string) => boolean;
  reacted?: (emoji: string) => boolean;
  showDelivery?: boolean;
}) {
  const tools = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const tool = selectReactionTool(tools);
  // Host-owned marker: message shortcuts open the picker through its trigger.
  return tool ? (
    <span className="contents" data-reaction-tool="">
      <ContributionBoundary
        key={contributionKey(tool)}
        fallback={<span role="status">Reactions unavailable</span>}
      >
        <OwnedReactionTool
          key={messageViewKey(props.session, props.scope, props.messageId)}
          registry={registry}
          tool={tool}
          {...props}
        />
      </ContributionBoundary>
    </span>
  ) : null;
}

function OwnedReactionTool({
  registry,
  tool,
  session,
  scope,
  messageId,
  disabled,
  select,
  reacted,
  showDelivery = true,
}: {
  registry: ContributionReader<ComposerTool>;
  tool: Contribution<ComposerTool>;
  session: RelaySession;
  scope: string;
  messageId: string;
  disabled: boolean;
  select?: (emoji: string) => boolean;
  reacted?: (emoji: string) => boolean;
  showDelivery?: boolean;
}) {
  const [error, setError] = useState<string>();
  const alive = useRef(false);
  const unavailable = useRef(disabled);
  useLayoutEffect(() => {
    unavailable.current = disabled;
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const Picker = tool.reactionComponent;
  return Picker ? (
    <>
      <Picker
        session={session}
        scope={scope}
        disabled={disabled}
        {...(reacted ? { reacted } : {})}
        select={(emoji) => {
          if (
            !alive.current ||
            unavailable.current ||
            !registry.snapshot().includes(tool)
          )
            return false;
          try {
            if (select) return select(emoji);
            session.messages.react(messageId, emoji);
            setError(undefined);
            return true;
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not add reaction. Try again.",
            );
            return false;
          }
        }}
      />
      {error && <span role="alert">{error}</span>}
      {showDelivery && session.outbox && (
        <ReactionDelivery session={session} messageId={messageId} />
      )}
    </>
  ) : null;
}

export function reactionTarget(event: Pick<EventData, "kind" | "tags">) {
  return event.kind === 7
    ? event.tags.find((tag) => tag[0] === "e")?.[1]
    : undefined;
}

/** The relay refuses a signed event after 15 minutes, so an older update is
 * sent again as a new event for the same reaction. An unconfirmed one may have
 * reached the relay, which a read by ID settles before anything is sent. */
async function retryReaction(session: RelaySession, item: OutgoingEvent) {
  const { outbox } = session;
  const { id, kind, pubkey, content, tags, created_at } = item.event;
  if (!outbox) return;
  if (Date.now() / 1000 - created_at < 15 * 60) return outbox.retry(id);
  if (item.delivery === "unknown") {
    const found = await session.readRemote(
      [
        {
          kinds: [kind],
          ids: [id],
          authors: [pubkey],
          limit: 1,
          consistency: "strong",
        },
      ],
      { priority: "foreground" },
    );
    if (found.some((event) => event.id === id)) {
      if (outbox.snapshot().some((saved) => saved.event.id === id))
        await outbox.dismiss(id);
      return;
    }
  }
  outbox.send({
    kind,
    content,
    tags: tags.filter(([name]) => name !== "client-id" && name !== "ms"),
  });
  await outbox.dismiss(id);
}

export function ReactionDelivery({
  session,
  messageId,
}: {
  session: RelaySession;
  messageId: string;
}) {
  const outbox = session.outbox;
  const operations = useSyncExternalStore(
    outbox?.subscribe ?? noSubscribe,
    outbox?.snapshot ?? emptyOperations,
    outbox?.snapshot ?? emptyOperations,
  );
  const [retrying, setRetrying] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string>();
  const retry = async (item: OutgoingEvent) => {
    if (!outbox || inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    setError(undefined);
    try {
      await retryReaction(session, item);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not retry the reaction. Try again.",
      );
    } finally {
      inFlight.current = false;
      setRetrying(false);
    }
  };
  const ours = operations.filter(
    (item) => session.messages.reactionTarget(item.event) === messageId,
  );
  const operation = ours.find((item) =>
    ["failed", "unknown"].includes(item.delivery),
  );
  if (!operation) return null;
  return (
    <>
      <span role="status">
        {operation.delivery === "failed"
          ? "Couldn’t update reaction."
          : "Reaction delivery not confirmed."}{" "}
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={retrying}
          onClick={() => retry(operation)}
        >
          Retry reaction
        </Button>
      </span>
      {error && <span role="alert">{error}</span>}
    </>
  );
}

const noSubscribe = () => () => {};
const empty: ReturnType<Outbox["snapshot"]> = Object.freeze([]);
const emptyOperations = () => empty;

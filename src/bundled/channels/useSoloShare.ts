import { useProfileGeneration } from "../../features/relay/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useChatConversions } from "../../features/solo/conversion";
import {
  canShareConversation,
  checkShareDestination,
  shareSoloChatAccess,
  soloChatLinkMessage,
} from "../../features/solo/share";
import { soloChatLinkName } from "../../features/solo/labels";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../../features/relay/channel-details-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import { channelText } from "../../features/channels/channel-icon";

export type ShareChannel = Pick<
  ChannelSummary,
  "id" | "name" | "private" | "channelType"
>;

/** Sharing a Solo chat to a channel, inside the access dialog. People are added
 * one at a time like any member. A channel share opens community reading without
 * enrolling the destination's members, then posts the link through the Outbox. */
export function useSoloShare({
  session,
  navigator: navigationController,
  channelId,
  enabled,
  signal,
  query,
  close,
}: {
  session: RelaySession;
  navigator?: Navigation | undefined;
  channelId: string;
  /** Only Solo chats share; channels keep every effect idle. */
  enabled: boolean;
  signal?: AbortSignal | undefined;
  query: string;
  close(): void;
}) {
  const notify = useToastNotification();
  useChatConversions(session);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const visible = () => mounted.current && !signal?.aborted;
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const [destination, setDestination] = useState("");
  const [rosterState, setRosterState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [rosterError, setRosterError] = useState("");
  const [rosterReload, setRosterReload] = useState(0);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmation, setConfirmation] = useState<ChannelDetails>();
  const running = useRef(false);
  const requestedAccess = useRef(new Map<string, ChannelDetailsDraft>());
  const accessChanged = useRef(false);
  const accessAttempt = useSyncExternalStore(
    session.channelDetails.subscribe,
    () => session.channelDetails.snapshot(channelId),
  );
  const checkRequired =
    accessAttempt?.status === "unconfirmed" &&
    accessAttempt.draft === requestedAccess.current.get(channelId);
  const source = list.channels.find((item) => item.id === channelId);
  const eligible = canShareConversation(session, source);
  const chosen = list.channels.find(
    (item) => item.id === destination && item.id !== channelId,
  );
  useEffect(() => {
    void rosterReload;
    if (!enabled) return;
    const controller = new AbortController();
    const cancelled = () => controller.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) controller.abort();
    setRosterState("loading");
    setRosterError("");
    void (
      session.channels.refreshRoster
        ? session.channels.refreshRoster(channelId, {
            consistency: "strong",
            signal: controller.signal,
          })
        : Promise.reject(
            new Error("Current access is unavailable on this connection."),
          )
    )
      .then((fresh) => {
        if (controller.signal.aborted) return;
        const current = session.channels
          .list()
          .channels.find((item) => item.id === channelId);
        if (!fresh || current?.cached || !current?.members)
          throw new Error("Current access could not be confirmed.");
        setRosterState("ready");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setRosterState("error");
          setRosterError(
            reason instanceof Error
              ? reason.message
              : "Current access could not be confirmed.",
          );
        }
      });
    return () => {
      controller.abort();
      signal?.removeEventListener("abort", cancelled);
    };
  }, [enabled, session, channelId, rosterReload, signal]);
  const profileGeneration = useProfileGeneration(session.profiles);
  const memberKeys =
    enabled && rosterState === "ready" && !source?.cached
      ? source?.members?.join(":")
      : "";
  useEffect(() => {
    void profileGeneration;
    if (memberKeys)
      void session.profiles
        .ensure(memberKeys.split(":"), "foreground")
        .catch(() => {});
  }, [session, memberKeys, profileGeneration]);
  useEffect(() => {
    if (!memberKeys) return;
    // Reuse the existing verified role reader; unknown owner/agent classification
    // stays unlabeled rather than being represented as private.
    void session.memberAdministration.refresh(channelId).catch(() => {});
  }, [session, channelId, memberKeys]);
  const channels: ShareChannel[] = list.channels
    .filter(
      (item) =>
        item.id !== channelId &&
        !item.huddle &&
        !item.metadataPending &&
        !item.readOnly &&
        !item.cached &&
        !item.archived &&
        ["stream", "forum"].includes(item.channelType ?? "") &&
        item.members?.includes(session.viewer ?? "") &&
        item.name
          .toLowerCase()
          .includes(query.trim().toLowerCase().replace(/^#/, "")),
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      ...(item.private ? { private: item.private } : {}),
      ...(item.channelType ? { channelType: item.channelType } : {}),
    }));
  const submit = async (target: string, confirmed?: ChannelDetails) => {
    if (!visible() || running.current || !target) return;
    if (!eligible) {
      setError(
        "Chat access changed. Close and reopen to check current access before retrying.",
      );
      return;
    }
    running.current = true;
    if (target !== destination) accessChanged.current = false;
    setDestination(target);
    setFailed(false);
    setBusy(true);
    setError("");
    setProgress("Checking chat access…");
    const controller = new AbortController();
    const cancelled = () => controller.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const active = controller.signal;
      await checkShareDestination(session, target, active);
      const confirmation = await shareSoloChatAccess(session, channelId, {
        signal: active,
        confirmed,
        attempts: requestedAccess.current,
        onAccessChanged: () => {
          accessChanged.current = true;
        },
        check: () => {
          active.throwIfAborted();
          if (!visible())
            throw new DOMException("Share cancelled", "AbortError");
        },
      });
      if (confirmation) {
        setConfirmation(confirmation);
        return;
      }
      active.throwIfAborted();
      if (!visible()) return;
      setConfirmation(undefined);
      setProgress("Posting chat link…");
      const current = session.channels
        .list()
        .channels.find((item) => item.id === channelId);
      const messageId = session.messages.send(
        target,
        soloChatLinkMessage(
          channelId,
          current ? soloChatLinkName(current) : undefined,
        ),
      );
      if (!visible()) return;
      const view =
        session.viewer &&
        buzzLinkTarget(`buzz://channel/${target}/${messageId}`, {
          viewer: session.viewer,
          communityOrigin: session.scope.slice(0, -(session.viewer.length + 1)),
        });
      const shared = session.channels
        .list()
        .channels.find((item) => item.id === target);
      notify(
        `${accessChanged.current ? "Chat changed to View only. " : ""}${shared ? `Shared in ${channelText(shared)}` : "Shared"}`,
        "success",
        view && navigationController
          ? {
              label: "View",
              onClick: () => {
                void navigationController.open(view);
              },
            }
          : undefined,
      );
      accessChanged.current = false;
      close();
    } catch (reason) {
      if (!visible()) return;
      setFailed(true);
      setError(
        `${reason instanceof Error ? reason.message : "Couldn’t share this chat."} The link was not posted. Any access change already saved is kept.`,
      );
    } finally {
      signal?.removeEventListener("abort", cancelled);
      running.current = false;
      if (visible()) {
        if (confirmed) setConfirmation(undefined);
        setBusy(false);
        setProgress("");
      }
    }
  };
  return {
    eligible,
    confirmation,
    cancelConfirmation: () => {
      accessChanged.current = false;
      setConfirmation(undefined);
    },
    confirm: () => submit(destination, confirmation),
    checkRequired,
    busy,
    failed,
    destination,
    chosen,
    source,
    rosterState,
    rosterError,
    reloadRoster: () => setRosterReload((value) => value + 1),
    channels,
    submit,
    error,
    progress,
  };
}

import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import {
  ActivityAccessory,
  ActivityTypingReplacement,
} from "./ActivityAccessory";
export const inject = ["relay", "conversation", "agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.effect(() => {
    let session: RelaySession | undefined;
    let release: (() => void) | undefined;
    const bind = () => {
      const connection = relay.snapshot();
      const next =
        connection.status === "ready" ? connection.session : undefined;
      if (next === session) return;
      release?.();
      session = next;
      release = next?.agentActivity.activate();
    };
    const stop = relay.subscribe(bind);
    bind();
    return () => {
      stop();
      release?.();
    };
  });
  ctx.conversation.registerAccessory({
    id: "activity",
    title: "Agent Activity",
    component: (props) => <ActivityAccessory {...props} agents={ctx.agents} />,
    placement: "response",
  });
  ctx.conversation.registerAccessory({
    id: "typing-presentation",
    title: "Agent typing presentation",
    component: ActivityTypingReplacement,
  });
};

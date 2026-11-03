import { nip19 } from "nostr-tools";
import { useState } from "react";
import { createActivityTab } from "../src/bundled/builderlab/adapter-type/Activity.tsx";
import { bundledPlugins as upstream } from "../src/bundled/index.ts";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../src/features/agents/service.ts";
import { prepareRemoteAgentAuthorization } from "../src/features/host/service.ts";
import type { BundledPlugin } from "../src/plugins/manager.ts";
import { writeClipboardText } from "../src/shared/clipboard.ts";
import { Button } from "../src/shared/design-system/ui/Button.tsx";
import { Checkbox } from "../src/shared/design-system/ui/Checkbox.tsx";
import { Field } from "../src/shared/design-system/ui/Field.tsx";
import { Input } from "../src/shared/design-system/ui/Input.tsx";

// Orb agents (or any other buzz-acp runner) keep their key on their own
// host. Pairing one lists it as the owner's hosted agent:
// the owner signs its NIP-OA tag (BUZZ_AUTH_TAG) and the Agents service
// writes the kind 30177 record with runtime `orb/agent`, which gives it the
// Memory and Activity tabs and makes it messageable.

type Config = Readonly<{ npub: string; confirmed: boolean }>;
const SAVED = "buzz.orb.auth:";

const pubkeyOf = (npub: string) => {
  try {
    const decoded = nip19.decode(npub.trim());
    return decoded.type === "npub" ? decoded.data : undefined;
  } catch {
    return undefined;
  }
};

function Pair({ config: draft, onChange, disabled }: AgentCreateProps) {
  const config = draft as Config;
  const pubkey = pubkeyOf(config.npub);
  return (
    <div className="grid gap-3">
      <Field
        label="Agent public key"
        description="The npub its host printed when it made the agent's key."
      >
        <Input
          placeholder="npub1…"
          value={config.npub}
          disabled={disabled}
          onChange={(event) =>
            onChange({ npub: event.target.value, confirmed: false })
          }
        />
      </Field>
      {pubkey && (
        <Checkbox
          checked={config.confirmed}
          disabled={disabled}
          onCheckedChange={(confirmed) => onChange({ ...config, confirmed })}
          label={
            <>
              This agent is mine:{" "}
              <code className="break-all font-mono">
                {nip19.npubEncode(pubkey)}
              </code>
              . Pairing can't be undone: the relay records me as its owner for
              good, and only a relay ban of this key revokes it.
            </>
          }
        />
      )}
    </div>
  );
}

function Setup({ agent }: AgentViewProps) {
  const [tag, setTag] = useState(() =>
    localStorage.getItem(SAVED + agent.pubkey),
  );
  const [status, setStatus] = useState("");
  const line = `BUZZ_AUTH_TAG=${tag}`;
  return (
    <div className="grid gap-3 text-body-sm">
      <p className="m-0 text-secondary">
        Its host runs it with its own key. Set this line in the agent's
        environment so the relay admits it as yours; it's a public attestation,
        safe to copy.
      </p>
      {tag ? (
        <>
          <code className="block select-text break-all font-mono">{line}</code>
          <div>
            <Button
              size="sm"
              onClick={() =>
                writeClipboardText(line).then(
                  () => setStatus("Copied."),
                  () => setStatus("Could not copy. Select the line instead."),
                )
              }
            >
              Copy
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button
            size="sm"
            onClick={() =>
              prepareRemoteAgentAuthorization(agent.pubkey).then(
                (auth) => {
                  const value = JSON.stringify(auth);
                  localStorage.setItem(SAVED + agent.pubkey, value);
                  setTag(value);
                },
                (error) => setStatus(String(error?.message ?? error)),
              )
            }
          >
            Show BUZZ_AUTH_TAG
          </Button>
        </div>
      )}
      <span role="status" className="text-secondary">
        {status}
      </span>
      <p className="m-0 text-secondary">
        Rename it or change its picture on its host. Deleting it here only
        removes it from your agents: to revoke its access, a relay admin bans
        its key.
      </p>
    </div>
  );
}

const orb: BundledPlugin = {
  manifest: {
    id: "orb",
    name: "Orb",
    apiVersion: 1,
    description: "Pair agents that run on your own Orb hosts.",
  },
  module: {
    inject: ["agents", "relay"],
    apply(ctx) {
      ctx.agents.register({
        id: "agent",
        title: "Orb",
        description: "Pair an agent that runs on your own host.",
        defaults: () => ({ config: { npub: "", confirmed: false } }),
        Create: Pair,
        tabs: [
          { id: "setup", title: "Setup", role: "settings", component: Setup },
          {
            id: "activity",
            title: "Activity",
            role: "activity",
            component: createActivityTab(ctx.relay),
          },
        ],
        remote: {
          async provision({ config }) {
            const { npub, confirmed } = config as Config;
            const pubkey = pubkeyOf(npub);
            if (!pubkey) throw new Error("Paste the agent's npub.");
            if (!confirmed)
              throw new Error("Confirm that this agent is yours.");
            return { pubkey };
          },
          async activate({ pubkey, auth }) {
            localStorage.setItem(SAVED + pubkey, JSON.stringify(auth));
          },
          async profile() {
            throw new Error("Rename it and change its picture on its host.");
          },
          async remove({ pubkey }) {
            localStorage.removeItem(SAVED + pubkey);
          },
        },
      });
    },
  },
};

/** The web build's plugins (src/app/services.ts): upstream's plus Orb, without
 * Builderlab, whose sign-in and hosted agents need the desktop app. */
export const bundledPlugins: readonly BundledPlugin[] = [
  ...upstream.filter(({ manifest }) => manifest.id !== "block.builderlab"),
  orb,
];

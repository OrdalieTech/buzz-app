// The real Claude Activity tab, with a long private channel among its saved
// conversations. Activity reads only saved sessions and the channel labels.
import { createRoot } from "react-dom/client";
import { ClaudeDefaults } from "../../src/bundled/claude-code/defaults";
import {
  ClaudeRuntime,
  type Config,
  DEFAULT_CONFIG,
} from "../../src/bundled/claude-code/runtime";
import { ClaudeSetup } from "../../src/bundled/claude-code/setup";
import { createTabs } from "../../src/bundled/claude-code/tabs";
import type { AgentReads } from "../../src/features/agents/reads";
import type { Agent } from "../../src/features/agents/service";
import "../../src/shared/styles/globals.css";

const KEY = "c".repeat(64);
const LONG = "confidential-architecture-and-production-release-planning";
localStorage.setItem(
  "buzz.claude-code.sessions.v1",
  JSON.stringify({
    [KEY]: {
      planning: { id: "s1", seen: 0, at: 2 },
      general: { id: "s2", seen: 0, at: 1 },
    },
  }),
);
const reads = {
  channelLabel: (id: string) =>
    id === "planning"
      ? { name: LONG, private: true, channelType: "stream" }
      : { name: "general", channelType: "stream" },
  ownerReadable: () => true,
} as unknown as AgentReads;
const { ActivityTab } = createTabs({
  setup: new ClaudeSetup(undefined),
  defaults: new ClaudeDefaults(),
  runtime: new ClaudeRuntime({} as never, () => reads, {} as never),
});
const width = Number(new URLSearchParams(location.search).get("width"));

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");

createRoot(root).render(
  <div style={{ width }}>
    <ActivityTab
      agent={
        {
          key: KEY,
          pubkey: KEY,
          name: "Claude",
          type: "buzz.claude-code/claude-code",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      save={async () => undefined}
    />
  </div>,
);

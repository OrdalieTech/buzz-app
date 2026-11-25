import { describe, expect, it } from "vitest";

import {
  agentPolicyMessage,
  agentPolicyRefusal,
  directMessageRefusal,
  sameDirectMessage,
} from "./direct-message-policy";

const viewer = "a".repeat(64);
const taylor = "b".repeat(64);
const robin = "c".repeat(64);
const agent = "d".repeat(64);
const isAgent = (key: string) => key === agent;

describe("sameDirectMessage", () => {
  it("never shows a DM of one person and their agents once a person is added", () => {
    const agentOnly = [viewer, agent];
    expect(sameDirectMessage(agentOnly, new Set(agentOnly), isAgent)).toBe(
      true,
    );
    expect(
      sameDirectMessage(agentOnly, new Set([viewer, agent, taylor]), isAgent),
    ).toBe(false);
    expect(
      sameDirectMessage(agentOnly, new Set([viewer, taylor]), isAgent),
    ).toBe(false);
  });

  it("matches a DM of two or more people by its people", () => {
    expect(
      sameDirectMessage(
        [viewer, taylor, agent],
        new Set([viewer, taylor]),
        isAgent,
      ),
    ).toBe(true);
    expect(
      sameDirectMessage(
        [viewer, taylor],
        new Set([viewer, taylor, robin]),
        isAgent,
      ),
    ).toBe(false);
  });
});

describe("an agent's add-policy refusal", () => {
  const owned = `forbidden: policy:owner_only — only the agent owner can add this agent (agent ${agent})`;
  const closed = `forbidden: policy:nobody — this agent has disabled external channel additions (agent ${agent})`;

  it("passes on the policy and agent, and reads them back", () => {
    const shown = directMessageRefusal(false, owned);
    expect(shown).toBe(`policy:owner_only (agent ${agent})`);
    // The browser host maps a refusal again on its way out.
    expect(directMessageRefusal(false, shown)).toBe(shown);
    expect(agentPolicyRefusal(shown)).toEqual({
      policy: "owner_only",
      agent,
    });
    expect(agentPolicyRefusal(directMessageRefusal(true, closed))).toEqual({
      policy: "nobody",
      agent,
    });
  });

  it("is an ordinary refusal without a whole agent key", () => {
    for (const reason of [
      "forbidden: policy:owner_only — only the agent owner can add this agent",
      `forbidden: policy:owner_only (agent ${agent.slice(1)})`,
      `forbidden: policy:owner_onlyx (agent ${agent})`,
      `forbidden: policy:anyone (agent ${agent})`,
    ]) {
      expect(agentPolicyRefusal(reason)).toBeUndefined();
      expect(directMessageRefusal(true, reason)).toBe(
        "Couldn’t add them. Try again.",
      );
    }
  });

  it("names the agent, and its owner when known, so the person knows whom to ask", () => {
    const owner = { policy: "owner_only", agent } as const;
    const nobody = { policy: "nobody", agent } as const;
    expect(agentPolicyMessage(false, owner, "Morgan’s Scout", "Morgan")).toBe(
      "Only Morgan can add Morgan’s Scout to a DM.",
    );
    expect(agentPolicyMessage(true, owner, "Scout", "Morgan")).toBe(
      "Couldn’t add them. Only Morgan can add Scout to a DM.",
    );
    expect(agentPolicyMessage(false, owner, "Scout")).toBe(
      "Only the owner of Scout can add it to a DM.",
    );
    expect(agentPolicyMessage(true, nobody, "Scout", "Morgan")).toBe(
      "Couldn’t add them. Scout can’t be added to a DM.",
    );
    expect(agentPolicyMessage(false, owner, undefined, "Morgan")).toBe(
      "Only Morgan can add this agent to a DM.",
    );
    expect(agentPolicyMessage(false, owner, undefined)).toBe(
      "Only the owner of this agent can add it to a DM.",
    );
    expect(agentPolicyMessage(true, nobody, undefined)).toBe(
      "Couldn’t add them. This agent can’t be added to a DM.",
    );
  });
});

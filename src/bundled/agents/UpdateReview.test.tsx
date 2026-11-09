// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentCreateProps,
  Agents,
  AgentUpdateRequest,
  RegisteredAgentType,
} from "../../features/agents/service";
import { UpdateReview } from "./UpdateReview";

afterEach(cleanup);

type Config = { reply: string; model: string };
const Create = ({ config, onChange }: AgentCreateProps<Config>) => (
  <textarea
    aria-label="Instructions"
    value={config.reply}
    onChange={(event) => onChange({ ...config, reply: event.target.value })}
  />
);
const kind = (key: string, title: string) => ({
  key,
  title,
  defaults: () => ({ config: { reply: "", model: "default" } }),
  adopt: ({ instructions }: { instructions?: string }, config: Config) => ({
    ...config,
    reply: instructions ?? config.reply,
  }),
  Create,
});

function fixture(change: Partial<AgentUpdateRequest>, waiting = false) {
  const request: AgentUpdateRequest = {
    id: "draft",
    requester: "a".repeat(64),
    requesterName: "Parent",
    owner: "b".repeat(64),
    community: "https://relay.example",
    agent: "c".repeat(64),
    agentName: "Child",
    agentType: "test/echo",
    ...change,
  };
  // One for an agent in a community that isn't connected now.
  let requests: readonly AgentUpdateRequest[] = waiting
    ? [{ ...request, id: "offline", agent: "d".repeat(64) }, request]
    : [request];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const types = [
    kind("test/echo", "Echo"),
    kind("test/other", "Other"),
  ] as unknown as readonly RegisteredAgentType[];
  const agent = {
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Child",
    picture: "https://example.test/child.png",
    type: "test/echo",
    config: { reply: "Be brief.", model: "large" },
  } as unknown as Agent;
  let snapshot = { running: [agent] };
  const agents = {
    /** Sets which agents are connected now. */
    connect: (running: readonly Agent[]) => {
      snapshot = { running: [...running] };
      for (const listener of listeners) listener();
    },
    agent,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    types: () => types,
    snapshot: () => snapshot,
    updateRequests: () => requests,
    approveUpdate: vi.fn(async () => clear()),
    dismissUpdate: vi.fn(clear),
    previewRetype: vi.fn(() => ({
      config: { reply: "Be brief.", model: "default" },
      moved: ["instructions"],
      dropped: [],
      settings: [],
    })),
  };
  render(<UpdateReview agents={agents as unknown as Agents} />);
  return agents;
}

it("edits the agent's settings with the proposed changes and saves what the owner reviewed", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid", instructions: "Review PRs." });
  const name = await screen.findByDisplayValue("Kid");
  expect(screen.getByText("Edit Child")).toBeVisible();
  expect(screen.getByText(/Parent proposed these changes\./)).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toHaveValue("Review PRs.");
  expect(agents.previewRetype).not.toHaveBeenCalled();
  expect(agents.approveUpdate).not.toHaveBeenCalled();
  await user.clear(name);
  await user.type(name, "Reviewer");
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith("draft", {
      type: "test/echo",
      name: "Reviewer",
      picture: "https://example.test/child.png",
      config: { reply: "Review PRs.", model: "large" },
    }),
  );
});

it("starts from a proposed picture and saves it with the review", async () => {
  const user = userEvent.setup();
  const agents = fixture({ picture: "https://example.test/proposed.png" });
  await screen.findByDisplayValue("Child");
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ picture: "https://example.test/proposed.png" }),
    ),
  );
});

it("previews a proposed harness change from the migrated settings", async () => {
  const user = userEvent.setup();
  const agents = fixture({ type: "test/other" });
  await screen.findByDisplayValue("Child");
  expect(agents.previewRetype).toHaveBeenCalledWith(
    "c".repeat(64),
    "test/other",
  );
  expect(screen.getByText(/The provider changes/)).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toHaveValue("Be brief.");
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        type: "test/other",
        config: { reply: "Be brief.", model: "default" },
      }),
    ),
  );
});

it("reviews the next request while another's agent is not connected", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid" }, true);
  await screen.findByDisplayValue("Kid");
  await user.click(screen.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(agents.dismissUpdate).toHaveBeenCalledWith("draft"),
  );
});

it("keeps the owner's edits while agents connect and disconnect", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid" }, true);
  const name = await screen.findByDisplayValue("Kid");
  await user.clear(name);
  await user.type(name, "Reviewer");
  const earlier = {
    ...agents.agent,
    key: "d".repeat(64),
    pubkey: "d".repeat(64),
  } as Agent;
  act(() => agents.connect([earlier, agents.agent]));
  act(() => agents.connect([earlier]));
  expect(screen.getByDisplayValue("Reviewer")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ name: "Reviewer" }),
    ),
  );
});

it("discards an unsaved change request when the owner closes its review", async () => {
  const user = userEvent.setup();
  const agents = fixture({ name: "Kid" });
  await screen.findByDisplayValue("Kid");
  await user.click(screen.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(agents.dismissUpdate).toHaveBeenCalledWith("draft"),
  );
  expect(agents.approveUpdate).not.toHaveBeenCalled();
});

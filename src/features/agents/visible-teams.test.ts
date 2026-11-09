import { expect, it } from "vitest";
import { visibleTeams } from "./visible-teams";
import type { Agents, AgentsSnapshot } from "./service";

it("shares local teams by membership and keeps confirmed synced teams in their home", () => {
  const local = {
    id: "local",
    name: "Local",
    instructions: "",
    members: ["ada"],
  };
  const synced = { ...local, id: "synced", revision: "head", members: ["bo"] };
  const elsewhere = { ...local, id: "elsewhere", members: ["bo"] };
  const empty = { ...local, id: "empty", members: [] };
  const missing = { ...local, id: "missing", members: ["missing"] };
  const snapshot = {
    teams: [local, synced, elsewhere, empty, missing],
    agents: [{ pubkey: "ada", relay: "wss://here.example", place: "here" }],
  } as unknown as AgentsSnapshot;
  const agents: Pick<Agents, "snapshot" | "memberships" | "teamHere"> = {
    snapshot: () => snapshot,
    memberships: (key) =>
      key === "missing"
        ? []
        : [
            {
              key,
              origin:
                key === "ada"
                  ? "https://here.example"
                  : "https://other.example",
              connected: true,
            },
          ],
    teamHere: ({ id }, origin) =>
      id === "synced" && origin === "https://here.example",
  };
  expect(visibleTeams(agents, "https://here.example").map((t) => t.id)).toEqual(
    ["local", "synced", "empty", "missing"],
  );
  // The snapshot contains only the selected community's agents. A retained
  // composer elsewhere must use memberships rather than that selected list.
  expect(
    visibleTeams(agents, "https://other.example").map((t) => t.id),
  ).toEqual(["synced", "elsewhere", "empty", "missing"]);
  expect(
    visibleTeams(agents, "https://third.example").map((t) => t.id),
  ).toEqual(["empty", "missing"]);
});

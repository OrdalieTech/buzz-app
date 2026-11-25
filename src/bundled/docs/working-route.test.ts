import { expect, it } from "vitest";
import {
  parseOpenTarget,
  type JsonValue,
} from "../../features/navigation/targets";
import { workingRoute, workingTarget } from "./working-route";

const id = "11111111-1111-4111-8111-111111111111";
const channel = "22222222-2222-4222-8222-222222222222";
const target = {
  version: 1,
  kind: "page",
  pluginId: "com.squareup.docs",
  pageId: "docs",
} as const;
it("round-trips browser, editor, dialog, revision and new-draft addresses without content", () => {
  for (const value of [
    { view: "browse", query: "Research", trash: true },
    { view: "doc", id, channel, edit: true, dialog: "link" },
    {
      view: "doc",
      id,
      channel,
      dialog: "history",
      revision: "a".repeat(64),
      offset: 100,
    },
    { view: "new", draft: id },
  ]) {
    const route = workingRoute(value as JsonValue);
    expect(route).toEqual(value);
    if (!route) throw new Error("Missing route");
    expect(parseOpenTarget(workingTarget(target, route))).toMatchObject({
      route: { params: value },
    });
  }
  expect(
    workingRoute({
      view: "doc",
      id,
      channel,
      edit: "true",
      community: "wss://docs.example.test",
    }),
  ).toEqual({
    view: "doc",
    id,
    channel,
    edit: true,
    community: "https://docs.example.test",
  });
  expect(workingRoute({ id, channel })).toBeUndefined();
});
it.each([
  { author: "b".repeat(64), doc: `30023:${"b".repeat(64)}:doc` },
  { view: "browse", author: "b".repeat(64) },
  { view: "shared", shared: `30023:${"b".repeat(64)}:doc` },
  { view: "profile", profile: "b".repeat(64) },
  { view: "doc", id, channel, markdown: "private draft" },
  { view: "doc", id, channel, revision: "a".repeat(64) },
  { view: "doc", id, channel, dialog: "share", offset: 100 },
  { view: "new", draft: "bad" },
  { view: "browse", edit: true },
  { view: "browse", folder: "custom" },
  { view: "browse", folder: "shared" },
  { view: "browse", query: "x".repeat(513) },
  { view: "doc", id, channel, shared: `30023:${"b".repeat(64)}:doc` },
])("rejects malformed or content-bearing presentation: %o", (value) => {
  expect(workingRoute(value)).toBeUndefined();
});

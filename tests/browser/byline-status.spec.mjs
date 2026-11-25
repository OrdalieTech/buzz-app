import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true });

// Browser-only: the production broker forwards the status read that follows a
// byline's profile read to the modeled relay, and the row renders what it
// returned.
test("a new author's status follows their name, and their row reads nothing more", async ({
  page,
  app,
}) => {
  await open(page, app);
  const key = generateSecretKey();
  const author = getPublicKey(key);
  app.serveProfile(key, { name: "Newcomer" });
  app.serveStatus(key, "🐝", "Buzzing");
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: "First post",
      tags: [["h", "alpha"]],
    },
    key,
  );
  app.relay.publish("primary", event);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row.getByText("Newcomer", { exact: true })).toBeVisible();
  await expect(row.getByRole("img", { name: /Buzzing/ })).toBeVisible();
  const reads = (kind) =>
    app.report.queries.filter(
      ({ filter }) =>
        filter.kinds?.includes(kind) && filter.authors?.includes(author),
    );
  // One of each: the row did not read the status again.
  await expect.poll(() => reads(0).length).toBe(1);
  expect(reads(30315)).toHaveLength(1);
});

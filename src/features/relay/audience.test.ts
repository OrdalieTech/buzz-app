import { expect, it } from "vitest";
import { detailsBrief, messageAudience } from "./audience";

const event = (...tags: string[][]) =>
  ({ tags }) as unknown as Parameters<typeof messageAudience>[0];

it("reads agents and details audiences; anything else is for everyone", () => {
  expect(messageAudience(event(["audience", "agents"]))).toBe("agents");
  expect(messageAudience(event(["audience", "details"]))).toBe("details");
  expect(messageAudience(event(["audience", "everyone"]))).toBeUndefined();
  expect(messageAudience(event(["audience", "detail"]))).toBeUndefined();
  expect(messageAudience(event())).toBeUndefined();
});

it("briefs details as their first paragraph, after a leading heading", () => {
  expect(detailsBrief("\nThe brief.\n\nHidden.\n\nAlso hidden.")).toBe(
    "The brief.",
  );
  expect(detailsBrief("# Title\n\nThe brief.\n\nHidden.")).toBe(
    "# Title\n\nThe brief.",
  );
  expect(detailsBrief("Only a brief.")).toBe("Only a brief.");
  // Markdown blocks end the brief without a blank line, as the chat shows it.
  expect(detailsBrief("Public brief.\n# Appendix\nPRIVATE_DETAIL")).toBe(
    "Public brief.",
  );
  expect(detailsBrief("Brief.\n- hidden item")).toBe("Brief.");
  expect(detailsBrief("Brief.\n```\nhidden\n```")).toBe("Brief.");
  expect(detailsBrief("Two lines\nof one brief.\n\nHidden.")).toBe(
    "Two lines\nof one brief.",
  );
});

it("skips blocks the chat doesn't render when choosing the brief", () => {
  const long = Array.from({ length: 80 }, (_, index) => `w${index}`).join(" ");
  expect(detailsBrief(`<!-- note -->\n\n${long}\n\nHidden.`)).toBe(long);
  expect(detailsBrief("[x]: https://secret.example/token\n\nBrief.")).toBe(
    "Brief.",
  );
  expect(detailsBrief("[^1]: A leading footnote.\n\nBrief.[^1]")).toBe(
    "Brief.[^1]",
  );
  expect(
    detailsBrief("# Title\n\n<!-- note -->\n\nThe brief.\n\nHidden."),
  ).toBe("# Title\n\nThe brief.");
  // Raw HTML the chat shows as text is a block, without its comments.
  expect(detailsBrief("<div><!-- note -->Shown</div>\n\nHidden.")).toBe(
    "<div>Shown</div>",
  );
  expect(detailsBrief("<!-- only a note -->")).toBe("");
});

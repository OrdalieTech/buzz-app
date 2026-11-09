import { expect, it } from "vitest";
import {
  checkinHourly,
  featureState,
  hasFeature,
  memory,
  restoredFeature,
  withFeature,
} from "./features";

const OPEN = "<!-- buzz:bestie/memory v1 -->";
const CLOSE = "<!-- /buzz:bestie/memory -->";

it("adds memory once, at the end, and removes only what it added", () => {
  const owner = "Be brief.\n\nAlways answer in French.\n";
  const on = withFeature(owner, memory, true);
  expect(on).toBe(
    `Be brief.\n\nAlways answer in French.\n\n${OPEN}\n${memory.text}\n${CLOSE}\n`,
  );
  expect(hasFeature(on, memory)).toBe(true);
  expect(withFeature(on, memory, true)).toBe(on);
  expect(withFeature(on, memory, false)).toBe(owner);
  expect(withFeature(owner, memory, false)).toBe(owner);
  // Empty instructions get the section alone, and come back empty.
  expect(withFeature("", memory, true)).toBe(
    `${OPEN}\n${memory.text}\n${CLOSE}\n`,
  );
  expect(withFeature(withFeature("", memory, true), memory, false)).toBe("");
});

it("keeps the owner's text on both sides of a section moved by hand", () => {
  const text = `Before.\n\n${OPEN}\nold rules\n${CLOSE}\n\nAfter.`;
  expect(hasFeature(text, memory)).toBe(true);
  expect(withFeature(text, memory, false)).toBe("Before.\n\nAfter.");
});

it("treats any version as on", () => {
  const later =
    "<!-- buzz:bestie/memory v2 -->\nnew rules\n<!-- /buzz:bestie/memory -->";
  expect(hasFeature(later, memory)).toBe(true);
  expect(withFeature(`Mine.\n\n${later}`, memory, false)).toBe("Mine.");
});

const count = (text: string) => text.split(OPEN).length - 1;

it("keeps memory on through the owner's edits around and inside it", () => {
  const on = withFeature("Be brief.", memory, true);
  // The section ends the text, so typing below it lands on its last line.
  expect(on.endsWith(CLOSE)).toBe(true);
  const edits: Record<string, [string, string]> = {
    "a new line below": [`${on}\nAlso French.`, "Be brief.\n\nAlso French."],
    "the closing marker's line": [
      `${on} Also French.`,
      "Be brief.\n\nAlso French.",
    ],
    "the opening marker's line": [
      on.replace(OPEN, `Note: ${OPEN}`),
      "Be brief.\n\nNote:",
    ],
    "the section's body": [
      on.replace("Append only.", "Append, never edit."),
      "Be brief.",
    ],
  };
  for (const [where, [text, off]] of Object.entries(edits)) {
    expect(featureState(text, memory), where).toBe("on");
    // On adds no second section, and Off removes it, edits and all.
    expect(withFeature(text, memory, true), where).toBe(text);
    expect(withFeature(text, memory, false), where).toBe(off);
    expect(
      count(withFeature(withFeature(text, memory, false), memory, true)),
      where,
    ).toBe(1);
  }
});

it("shows a section whose markers were edited, and adds no second one", () => {
  const on = withFeature("Be brief.", memory, true);
  const damaged = [
    on.replace(CLOSE, "<!-- /buzz:bestie/memory-->"),
    on.replace(CLOSE, ""),
    on.replace(OPEN, "<!-- buzz:bestie/memory -->"),
    on.replace(OPEN, ""),
    // A whole one beside an edited one.
    `${on}\n\n${OPEN}\nmy copy`,
    // A marker quoted in the owner's text can't be told from an edited one.
    `Never edit ${OPEN} by hand.`,
  ];
  for (const text of damaged) {
    expect(featureState(text, memory), text).toBe("edited");
    expect(hasFeature(text, memory)).toBe(false);
    expect(withFeature(text, memory, true)).toBe(text);
  }
  expect(featureState("Be brief.", memory)).toBe("off");
  // Another feature's markers are not this one's.
  expect(featureState(withFeature("", checkinHourly, true), memory)).toBe(
    "off",
  );
});

it("restores an edited section only where its markers show it was", () => {
  const on = withFeature("Be brief.", memory, true);
  const edited = on
    .replace(CLOSE, "<!-- /buzz:bestie/memory--> Also French.")
    .replace("Append only.", "Edited.");
  const restored = restoredFeature(edited, memory);
  expect(restored).toBe(`${on} Also French.`);
  expect(featureState(restored ?? "", memory)).toBe("on");
  // With a whole copy too, one section is left.
  expect(count(restoredFeature(`${edited}\n\n${on}`, memory) ?? "")).toBe(1);
  // A missing marker leaves where it ended to the owner.
  expect(restoredFeature(on.replace(CLOSE, ""), memory)).toBeUndefined();
  expect(restoredFeature(on.replace(OPEN, ""), memory)).toBeUndefined();
  expect(
    restoredFeature(`Never edit ${OPEN} by hand.`, memory),
  ).toBeUndefined();
  // Only the markers and what lies between them are replaced: text after a
  // closing marker whose comment broke stays.
  const broken = on.replace(CLOSE, "<!-- /buzz:bestie/memory -- Mine.");
  expect(restoredFeature(broken, memory)).toBe(`${on} -- Mine.`);
  // A name in the owner's prose, or another section between, can't be told
  // from the section's own markers.
  expect(
    restoredFeature(
      `See buzz:bestie/memory.\n\nMy rules.\n\n${on.replace(OPEN, "")}`,
      memory,
    ),
  ).toBeUndefined();
  const other = withFeature("", checkinHourly, true);
  expect(
    restoredFeature(
      `${OPEN.replace(" v1", "")}\nrules\n\n${other}\n${CLOSE.replace(" -->", "-->")}`,
      memory,
    ),
  ).toBeUndefined();
});

it("leaves the owner's text when it removes every section", () => {
  const on = withFeature("Be brief.", memory, true);
  const twice = `${on}\n${OPEN}\ncopy\n${CLOSE}\n\n    indented code`;
  const off = withFeature(twice, memory, false);
  expect(off).toBe("Be brief.\n\n    indented code");
  expect(featureState(off, memory)).toBe("off");
});

it("finds a section in Windows line endings", () => {
  const text = `Mine.\r\n\r\n${OPEN}\r\nrules\r\n${CLOSE}\r\n`;
  expect(hasFeature(text, memory)).toBe(true);
  expect(withFeature(text, memory, false)).toBe("Mine.\r\n");
});

it("keeps the owner's line ending, or its absence, through on and off", () => {
  for (const owner of ["Be brief.", "Be brief.\n", "Be brief.\n\n", "A.\r\n"]) {
    const on = withFeature(owner, memory, true);
    expect(withFeature(on, memory, false)).toBe(owner);
  }
  // With two sections, removed in either order.
  const both = withFeature(
    withFeature("Be brief.\n", memory, true),
    { ...memory, id: "other" },
    true,
  );
  expect(
    withFeature(
      withFeature(both, memory, false),
      { ...memory, id: "other" },
      false,
    ),
  ).toBe("Be brief.\n");
  expect(
    withFeature(
      withFeature(both, { ...memory, id: "other" }, false),
      memory,
      false,
    ),
  ).toBe("Be brief.\n");
});

it("has the check-in read the private channels Bestie was added to", () => {
  const load = checkinHourly.text
    .split("\n")
    .find((line) => line.startsWith("1. LOAD."));
  expect(load).toContain("each private channel you have been added to");
  expect(load).toContain("you are a guest there and can't post");
});

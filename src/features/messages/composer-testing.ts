import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { readComposerDocument } from "./composer-document";
import {
  type DraftRecipient,
  type MentionDraft,
  type MentionRecipient,
  mentionDraft,
} from "./mention-draft";

/** jsdom has no layout/hit testing. Supply only the browser APIs ProseMirror
 * needs to edit; geometry and native selection remain browser-test contracts. */
export function composerDOMFixture() {
  const rect = new DOMRect(0, 0, 100, 20);
  const originals = [
    [Range.prototype, "getClientRects"],
    [Range.prototype, "getBoundingClientRect"],
    [document, "elementFromPoint"],
    [window, "scrollBy"],
  ] as const;
  const descriptors = originals.map(([target, name]) =>
    Object.getOwnPropertyDescriptor(target, name),
  );
  beforeEach(() => {
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [rect],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => rect,
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => null,
    });
  });
  afterEach(() => {
    originals.forEach(([target, name], index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    });
  });
}

/** A draft as the editor saves it, with the snapshot of its content: the
 * recipients are tokens. A saved tag without one is a legacy follow-up. */
export function typedDraft(draft: MentionDraft): MentionDraft {
  const doc = readComposerDocument(
    draft,
    draft.recipients.map(({ start, end }) => ({ start, end })),
  );
  return mentionDraft({
    ...draft,
    document: { version: 1, content: doc.toJSON() },
  });
}

/** A long status update as Buzz copies it: nine bold section titles, each over
 * a list. Each of the 38 items opens with a pull request link; the last lists
 * eight, 45 in all. Placeholder prose only. */
export function longRichDraft() {
  const words = "alpha bravo charlie delta echo foxtrot golf hotel".split(" ");
  const prose = (seed: number) =>
    Array.from(
      { length: 5 + (seed % 9) },
      (_, i) => words[(seed + i) % words.length],
    ).join(" ");
  const pull = (n: number, label = `#${n}`) =>
    `<a href="https://github.com/example/app/pull/${n}">${label}</a>`;
  let html = "";
  let n = 100;
  const sections = [3, 5, 4, 6, 3, 8, 4, 3, 2];
  sections.forEach((items, section) => {
    html += `<p><strong>Section title (${section + 1})</strong></p><ul>`;
    for (let item = 0; item < items; item++) {
      n += 7;
      if (section === sections.length - 1 && item === items - 1) {
        const pulls = Array.from({ length: 8 }, (_, i) => pull(n + i));
        html += `<li>${pulls.join(", ")}</li>`;
        continue;
      }
      const extra = [
        " ⚠️ check",
        " “quoted” isn’t",
        " ⌘K",
        " &lt;Name&gt; in #general",
      ][item % 4];
      html += `<li>${pull(n, item % 3 ? `#${n}` : `repo #${n}`)} ${prose(n)}${extra}</li>`;
    }
    html += "</ul>";
  });
  return `<div data-buzz-copy>${html}</div>`;
}

/** Paste `html` as a copied Buzz message, keeping its structure and chips. */
export function pasteRichDraft(input: HTMLElement, html: string) {
  act(() => {
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        types: ["text/plain", "text/html"],
        getData: (type: string) => (type === "text/html" ? html : "copied"),
      },
    });
  });
}

/** Placeholder people with deterministic keys, for mention-heavy drafts. */
export function placeholderPeople(count = 20): MentionRecipient[] {
  return Array.from({ length: count }, (_, i) => ({
    pubkey: (i + 1).toString(16).padStart(64, "0"),
    name: `Member${i + 1}`,
  }));
}

/** A long update naming people: every one of `people` is a recipient chip,
 * two or three per sentence of placeholder prose. */
export function longMentionDraft(people: readonly MentionRecipient[]) {
  const words = "alpha bravo charlie delta echo foxtrot golf hotel".split(" ");
  let text = "";
  const recipients: DraftRecipient[] = [];
  people.forEach((person, i) => {
    if (i % 3 === 0) text += `${text ? ". " : ""}Thanks `;
    else text += i % 3 === 1 ? ", " : " and ";
    const start = text.length;
    text += `@${person.name}`;
    recipients.push({ ...person, start, end: text.length });
    if (i % 3 === 2 || i === people.length - 1)
      text += ` for ${words[i % words.length]} ${words[(i + 3) % words.length]}`;
  });
  return typedDraft(mentionDraft({ text, recipients }));
}

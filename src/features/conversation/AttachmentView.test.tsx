// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Contribution, MatchOrder } from "../../plugins/contributions";
import type { Attachment } from "../relay/contracts";
import { AttachmentView } from "./AttachmentView";
import type { AttachmentRenderer, ContributionReader } from "./contracts";

afterEach(cleanup);

const markdown: Attachment = {
  url: "https://relay.test/media/notes.md",
  kind: "file",
  name: "notes.md",
};

const renderer = (
  key: string,
  options: {
    order?: MatchOrder<Attachment>;
    matches?: (attachment: Attachment) => boolean;
  } = {},
): Contribution<AttachmentRenderer> => {
  const [pluginId = key, id = key] = key.split("/");
  return Object.freeze({
    id,
    title: id,
    key,
    pluginId,
    revision: "one",
    matches: options.matches ?? (() => true),
    ...(options.order === undefined ? {} : { order: options.order }),
    component: () => <span>drawn by {key}</span>,
  });
};

const reader = (
  entries: readonly Contribution<AttachmentRenderer>[],
): ContributionReader<AttachmentRenderer> => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});

const view = (entries: readonly Contribution<AttachmentRenderer>[]) =>
  render(
    <AttachmentView
      registry={reader(entries)}
      attachment={markdown}
      source="https://relay.test/media/notes.md"
      fallback={<span>host card</span>}
    />,
  );

it("draws the lowest-order renderer whatever its activation order", () => {
  view([
    renderer("a.catchall/file", { order: 100 }),
    renderer("z.reader/markdown", { order: -10 }),
    renderer("m.default/any"),
  ]);
  expect(screen.getByText("drawn by z.reader/markdown")).toBeInTheDocument();
});

it("breaks equal orders by contribution key", () => {
  view([renderer("z.second/file"), renderer("a.first/file")]);
  expect(screen.getByText("drawn by a.first/file")).toBeInTheDocument();
});

it("passes the attachment to an order function and skips throwing matchers", () => {
  const seen: Attachment[] = [];
  view([
    renderer("a.broken/file", {
      order: -100,
      matches: () => {
        throw new Error("broken");
      },
    }),
    renderer("b.reader/file", {
      order: (attachment) => {
        seen.push(attachment);
        return attachment.name?.endsWith(".md") ? -10 : 0;
      },
    }),
    renderer("a.default/file"),
  ]);
  expect(seen).toEqual([markdown]);
  expect(screen.getByText("drawn by b.reader/file")).toBeInTheDocument();
});

it("keeps the host card when nothing matches", () => {
  view([renderer("a.pdf/file", { matches: () => false })]);
  expect(screen.getByText("host card")).toBeInTheDocument();
});

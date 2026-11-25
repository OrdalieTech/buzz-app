// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MarkdownPage } from "./MarkdownPage";

afterEach(cleanup);

it("renders maintained heading, list, table, and fenced-code structure", () => {
  render(
    createElement(MarkdownPage, {
      source: [
        "# Guide",
        "",
        "## Forms",
        "",
        "### Field composition",
        "",
        "Read **the label** and `Field`.",
        "",
        "- Keep labels visible",
        "  across wrapped lines.",
        "",
        "1. Choose a control",
        "2. Add a label",
        "",
        "| Role | Use |",
        "| --- | --- |",
        "| `Field` | A label |",
        "",
        "```tsx",
        '<Field label="Name">',
        "  <Input />",
        "</Field>",
        "```",
      ].join("\n"),
      documentPath: "src/shared/design-system/DESIGN.md",
    }),
  );
  expect(
    screen.getByRole("heading", { level: 3, name: "Field composition" }),
  ).toHaveAttribute("id", "field-composition");
  expect(screen.getByText("the label").tagName).toBe("STRONG");
  expect(screen.getAllByRole("list")[1]?.tagName).toBe("OL");
  expect(
    screen.getByText("Keep labels visible across wrapped lines."),
  ).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "Field" })).toBeInTheDocument();
  expect(screen.getByText(/<Field label=/).closest("pre")?.textContent).toBe(
    '<Field label="Name">\n  <Input />\n</Field>',
  );
});

it("resolves source-relative documents and preserves viewer section links", () => {
  render(
    createElement(MarkdownPage, {
      documentPath: "src/shared/design-system/DESIGN.md",
      source:
        "# Guide\n\n[Guide](DESIGN.md) and [system documentation](../../../docs/browser-testing.md).\n\n[Identity](#identity-shapes) and [specification](https://example.com/type).\n\n## Identity shapes",
    }),
  );
  expect(screen.getByRole("link", { name: "Guide" })).toHaveAttribute(
    "href",
    "#/design/design-guide",
  );
  expect(
    screen.getByRole("link", { name: "system documentation" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/blob/main/docs/browser-testing.md",
  );
  expect(screen.getByRole("link", { name: "Identity" })).toHaveAttribute(
    "href",
    "#/design/design-guide#identity-shapes",
  );
  expect(
    screen.getByRole("heading", { name: "Identity shapes" }),
  ).toHaveAttribute("id", "identity-shapes");
  expect(screen.getByRole("link", { name: "specification" })).toHaveAttribute(
    "href",
    "https://example.com/type",
  );
});

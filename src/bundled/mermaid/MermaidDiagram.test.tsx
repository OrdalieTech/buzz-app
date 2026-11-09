// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationService } from "../../features/conversation/service";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { createPluginManager } from "../../plugins/manager";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import * as mermaid from "./index";
import manifest from "./manifest.json";
import { MermaidDiagram } from "./MermaidDiagram";
import { MermaidExpand } from "./MermaidExpand";

const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  localStorage.removeItem("buzzodz.plugins.v1");
  vi.restoreAllMocks();
});

it("draws mermaid fences in messages while the bundled plugin is enabled", async () => {
  const ctx = new Context();
  const plugins = createPluginManager(ctx, {
    bundled: [{ manifest: { ...manifest, apiVersion: 1 }, module: mermaid }],
  });
  const service = new ConversationService(ctx);
  disposals.push(async () => {
    await plugins.dispose();
    await ctx.fiber.dispose();
  });
  const view = render(
    <MessageMarkdown
      row={{
        id: "message",
        channelId: "channel",
        authorId: "author",
        content:
          "Flow:\n\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```",
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      extensions={service}
      media={() => undefined}
      onOpenLink={() => false}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() =>
    expect(view.container.querySelector("svg.pele")).toHaveTextContent("Start"),
  );
  expect(view.container.querySelector("pre")).toBeNull();
  expect(
    screen.getAllByRole("button").map((button) => button.ariaLabel),
  ).toEqual(["Expand diagram", "Copy code block"]);

  await act(() => plugins.change("disable", "buzz.mermaid"));
  expect(view.container.querySelector("svg.pele")).toBeNull();
  expect(view.container.querySelector("pre code")).toHaveClass(
    "language-mermaid",
  );
});

it("draws a diagram without links or images, and redraws edited source", async () => {
  const view = render(
    <MermaidDiagram
      code={
        'flowchart LR\n  A[Start] --> B[End]\n  click A "https://example.com"'
      }
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelector("svg")).not.toBeNull(),
  );
  const svg = view.container.querySelector("svg");
  expect(svg).toHaveTextContent("Start");
  expect(svg?.querySelector("a")).toBeNull();

  view.rerender(<MermaidDiagram code={"flowchart LR\n  C[Edited]"} />);
  await waitFor(() =>
    expect(view.container.querySelector("svg")).toHaveTextContent("Edited"),
  );
});

it("shows the error and source for an invalid diagram, then recovers", async () => {
  const broken = "flowchart LR\n  A --> (";
  const view = render(<MermaidDiagram code={broken} />);
  expect(await screen.findByText(/^Parse error on line 2/)).toBeVisible();
  expect(screen.getByText(/^flowchart LR/)).toHaveTextContent(broken, {
    normalizeWhitespace: false,
  });
  expect(view.container.querySelector("svg")).toBeNull();

  view.rerender(<MermaidDiagram code={"flowchart LR\n  A --> B"} />);
  await waitFor(() =>
    expect(view.container.querySelector("svg")).not.toBeNull(),
  );
  expect(screen.queryByText(/^Parse error/)).toBeNull();
  expect(screen.queryByText(/^flowchart LR/)).toBeNull();
});

it("shows the source instead of drawing a diagram too large to draw", async () => {
  // Within Pele's default limits, but far larger than the app draws.
  const huge = `flowchart LR\n${Array.from({ length: 1000 }, (_, i) => `n${i}`).join("-->")}`;
  const view = render(<MermaidDiagram code={huge} />);
  expect(
    await screen.findByText(/^Diagram output is longer than the limit/),
  ).toBeVisible();
  expect(screen.getByText(/^flowchart LR/)).toHaveTextContent(huge, {
    normalizeWhitespace: false,
  });
  expect(view.container.querySelector("svg")).toBeNull();
});

it("expands the diagram in a dialog that copies its source and restores focus", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const code = "flowchart LR\n  A[Start] --> B[End]";
  render(<MermaidExpand code={code} />, { wrapper: ToastProvider });
  const expand = screen.getByRole("button", { name: "Expand diagram" });
  await user.click(expand);
  const dialog = await screen.findByRole("dialog", { name: "Mermaid diagram" });
  await waitFor(() =>
    expect(dialog.querySelector("svg.pele")).toHaveTextContent("Start"),
  );
  await user.click(within(dialog).getByRole("button", { name: "Copy code" }));
  expect(write).toHaveBeenCalledWith(code);
  await screen.findByText("Copied code to clipboard");
  await user.click(
    within(dialog).getByRole("button", { name: "Close diagram" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Mermaid diagram" }),
    ).toBeNull(),
  );
  expect(expand).toHaveFocus();
});

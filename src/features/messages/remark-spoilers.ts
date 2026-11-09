import type { Spoiler } from "mdast";
import type { Handle } from "mdast-util-to-markdown";

// A local Markdown node shared by composition serialization and message rendering.
declare module "mdast" {
  interface Spoiler extends Parent {
    type: "spoiler";
    children: PhrasingContent[];
  }
  interface PhrasingContentMap {
    spoiler: Spoiler;
  }
  interface RootContentMap {
    spoiler: Spoiler;
  }
}

declare module "mdast-util-to-markdown" {
  interface ConstructNameMap {
    spoiler: "spoiler";
  }
}

export const spoilerMarkdown: Handle = (node, _parent, state, info) => {
  const exit = state.enter("spoiler");
  const value = state.containerPhrasing(node as Spoiler, {
    ...info,
    before: "|",
    after: "|",
  });
  exit();
  return `||${value}||`;
};

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName: string; hProperties: Record<string, string> };
};

/** Only source-verified delimiters are protected before Markdown parsing. Escaped
 * pipes, entities, code and table syntax can never become spoilers after decoding. */
export function remarkSpoilers(delimiter: string, hideUnclosed = false) {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || ["code", "inlineCode", "html"].includes(node.type))
        return;
      for (const child of node.children) visit(child);
      const output: Node[] = [];
      let hidden: Node[] | undefined;
      const add = (child: Node) => (hidden ?? output).push(child);
      for (const child of node.children) {
        if (child.type !== "text" || !child.value?.includes(delimiter)) {
          add(child);
          continue;
        }
        child.value.split(delimiter).forEach((value, index) => {
          if (index) {
            if (hidden) {
              if (hidden.length)
                output.push({
                  type: "spoiler",
                  children: hidden,
                  data: {
                    hName: "span",
                    hProperties: { "data-spoiler": "true" },
                  },
                });
              else output.push({ type: "text", value: "||||" });
              hidden = undefined;
            } else hidden = [];
          }
          if (value) add({ type: "text", value });
        });
      }
      if (hidden) {
        // A bounded preview may stop before the closing delimiter. Never
        // expose the remainder of a spoiler just because its source was cut.
        if (hideUnclosed) output.push({ type: "spoiler", children: hidden });
        else output.push({ type: "text", value: "||" }, ...hidden);
      }
      node.children = output;
    };
    visit(tree);
  };
}

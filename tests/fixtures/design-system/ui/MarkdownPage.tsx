import { createElement, type ReactNode } from "react";
import { PageHeader } from "./primitives";

const DOCUMENT_ROUTES: Record<string, string> = {
  "src/shared/design-system/DESIGN.md": "/design/design-guide",
};
const REPOSITORY = "https://github.com/block/buzz-app/blob/main/";

function linkDestination(destination: string, documentPath: string) {
  const resolved = new URL(destination, `${REPOSITORY}${documentPath}`);
  if (!["https:", "http:", "mailto:"].includes(resolved.protocol))
    return undefined;
  const path = resolved.href.startsWith(REPOSITORY)
    ? resolved.href.slice(REPOSITORY.length).split(/[?#]/)[0]
    : undefined;
  const route = path && DOCUMENT_ROUTES[path];
  return route ? `#${route}${resolved.hash}` : resolved.href;
}

function inline(text: string, documentPath: string): ReactNode[] {
  let occurrence = 0;
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/)
    .map((part) => {
      occurrence += 1;
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={`${occurrence}-${part}`}>{part.slice(1, -1)}</code>;
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={`${occurrence}-${part}`}>
            {inline(part.slice(2, -2), documentPath)}
          </strong>
        );
      }
      const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
      if (link) {
        const href = linkDestination(link[2] ?? "", documentPath);
        return href ? (
          <a key={`${occurrence}-${part}`} href={href}>
            {inline(link[1] ?? "", documentPath)}
          </a>
        ) : (
          link[1]
        );
      }
      return part;
    });
}

/** A bounded reader for the maintained system docs, using their existing headings,
 * links, lists, pipe tables and fenced examples. Raw HTML remains ordinary text. */
export function MarkdownPage({
  source,
  documentPath,
}: {
  source: string;
  documentPath: string;
}) {
  const content: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  let table: string[][] = [];
  let code: string[] | undefined;
  const headingIds = new Map<string, number>();
  const renderInline = (text: string) => inline(text, documentPath);

  const flushParagraph = () => {
    if (!paragraph.length) return;
    content.push(
      <p className="design-doc-paragraph" key={`p-${content.length}`}>
        {renderInline(paragraph.join(" "))}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    content.push(
      createElement(
        ordered ? "ol" : "ul",
        { className: "design-doc-list", key: `l-${content.length}` },
        list.map((item) => <li key={item}>{renderInline(item)}</li>),
      ),
    );
    list = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const [head = [], ...body] = table;
    content.push(
      <div key={`t-${content.length}`}>
        <p className="design-doc-table-hint text-body-sm text-tertiary">
          Wide tables scroll horizontally.
        </p>
        <section
          className="design-doc-table-scroll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard readers need to scroll wide reference tables.
          tabIndex={0}
          aria-label={`${head.join(", ")} table; scroll for more columns`}
          onKeyDown={(event) => {
            const region = event.currentTarget;
            if (
              event.target !== region ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              region.scrollWidth <= region.clientWidth ||
              (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
            )
              return;
            // WebKit focuses overflow regions without scrolling them with arrow keys.
            event.preventDefault();
            region.scrollBy({
              left: event.key === "ArrowRight" ? 40 : -40,
              behavior: "instant",
            });
          }}
        >
          <table className="design-doc-table">
            <thead>
              <tr>
                {head.map((cell) => (
                  <th
                    scope="col"
                    className="text-label-sm text-tertiary"
                    key={cell}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row) => (
                <tr key={row.join("|")}>
                  {row.map((cell, index) => (
                    <td
                      className="text-body text-secondary"
                      key={head[index] ?? index}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>,
    );
    table = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
    flushTable();
  };
  const flushCode = () => {
    if (code)
      content.push(
        <pre className="design-doc-code text-mono" key={`c-${content.length}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    code = undefined;
  };

  for (const line of source.split("\n")) {
    if (line.startsWith("```")) {
      if (code) flushCode();
      else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const item = /^(-|\d+\.) (.+)$/.exec(line);
    if (heading) {
      flush();
      const title = heading[2] ?? "";
      const slug = title
        .toLowerCase()
        .replace(/[`*]/g, "")
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
        .replace(/\s+/g, "-");
      const count = headingIds.get(slug) ?? 0;
      headingIds.set(slug, count + 1);
      const id = count ? `${slug}-${count}` : slug;
      const level = heading[1]?.length;
      content.push(
        level === 1 ? (
          <PageHeader key={id} title={title} />
        ) : (
          createElement(
            level === 2 ? "h2" : "h3",
            {
              id,
              key: id,
              className: `design-doc-heading ${level === 2 ? "text-label" : "text-label-sm"} text-primary`,
            },
            renderInline(title),
          )
        ),
      );
    } else if (item) {
      flushParagraph();
      flushTable();
      const nextOrdered = item[1] !== "-";
      if (ordered !== nextOrdered) flushList();
      ordered = nextOrdered;
      list.push(item[2] ?? "");
    } else if (line.trim().startsWith("|")) {
      flushParagraph();
      flushList();
      if (!/^\|[\s|:-]+\|$/.test(line.trim())) {
        table.push(
          line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim()),
        );
      }
    } else if (!line.trim()) {
      flush();
    } else if (list.length && /^\s+\S/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      flushTable();
      paragraph.push(line.trim());
    }
  }
  flush();
  flushCode();
  return <article className="design-doc text-body">{content}</article>;
}

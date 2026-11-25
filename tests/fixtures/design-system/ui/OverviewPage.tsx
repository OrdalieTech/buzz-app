import { Link } from "@tanstack/react-router";

import { GRAMMAR } from "../../../../src/shared/design-system/tokens/registry";

import { PageHeader, Section } from "./primitives";

const LAYERS: Array<[string, string, string]> = [
  [
    "Palette",
    "--purple-1…12, --neutral-1…12",
    "public, authored in both modes",
  ],
  [
    "Roles",
    "--surface-panel, --text-standard",
    "names for each color’s purpose",
  ],
  ["Components", "Button, Panel, Tabs", "shared appearance and interaction"],
];

export function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Buzz Design System"
        intro="Build Buzz interfaces with shared foundations and components. Start with the design guide, explore the tokens, or try a component’s examples and states."
      />

      <Section
        title="The layers"
        description="Use semantic roles for surfaces, text, borders and controls. The shared palette supplies their values. Glass is available as a complete material."
      >
        <div className="flex flex-col gap-2 rounded-xl bg-neutral-2 px-6 py-5">
          {LAYERS.map(([layer, what, why]) => (
            <div key={layer} className="flex flex-wrap items-baseline gap-x-4">
              <span className="min-w-24 shrink-0 text-body text-tertiary">
                {layer}
              </span>
              <code className="min-w-0 flex-1 text-body-sm text-primary">
                {what}
              </code>
              <span className="text-body text-secondary">{why}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="The grammar">
        <div className="rounded-lg bg-neutral-11 px-5 py-4">
          <code className="text-body text-neutral-1">{GRAMMAR}</code>
        </div>
        <p className="text-body text-secondary">
          Name a token by its purpose, emphasis, and state. For guidance on
          using the system, read the{" "}
          <Link to="/design/design-guide" className="text-purple-12 underline">
            Design guide
          </Link>
          .
        </p>
      </Section>

      <Section title="Find what you need">
        <dl className="flex flex-col gap-6">
          {(
            [
              [
                "Foundations",
                "/design/color",
                "The shared visual rules: color, typography, spacing, shape, and motion.",
              ],
              [
                "Components",
                "/design/components",
                "Reusable controls and surfaces. Try each component’s variants and states.",
              ],
              [
                "Patterns",
                "/design/forms",
                "Components working together in a task, such as a form or a message thread.",
              ],
              [
                "Guides",
                "/design/design-guide",
                "How to design, build, and contribute to the system.",
              ],
              [
                "Layout playgrounds",
                "/design/components/workspace",
                "Experimental page layouts to explore before adopting them in the app.",
              ],
            ] as const
          ).map(([name, to, description]) => (
            <div key={name} className="flex flex-col gap-2">
              <dt className="text-label text-primary">
                <Link to={to} className="underline">
                  {name}
                </Link>
              </dt>
              <dd className="text-body text-secondary">{description}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}

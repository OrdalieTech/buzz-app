// Builds the base prompt from its sections. The host picks each section's
// text before the model sees it, so the prompt states one rule per topic.
import { type Facts, SECTIONS } from "./index";

export function composeBase(facts: Facts) {
  const text = SECTIONS.map((section) => {
    const body = (
      typeof section.text === "string" ? section.text : section.text(facts)
    ).trim();
    return section.title ? `## ${section.title}\n\n${body}` : body;
  }).join("\n\n");
  return { text };
}

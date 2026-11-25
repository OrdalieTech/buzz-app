import designSource from "../../../../src/shared/design-system/DESIGN.md?raw";
import { MarkdownPage } from "./MarkdownPage";

const DOCUMENTS = {
  design: {
    source: designSource,
    documentPath: "src/shared/design-system/DESIGN.md",
  },
} as const;

export function SystemDocumentPage({
  document,
}: {
  document: keyof typeof DOCUMENTS;
}) {
  return <MarkdownPage {...DOCUMENTS[document]} />;
}

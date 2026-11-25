import type {
  DocumentEditorHandle,
  DocumentEditorProps,
} from "../../plugins/author";
import { MAX_DOC_BYTES } from "./model";
import { useDocsUi } from "./ui";

export type DocEditorHandle = DocumentEditorHandle;
export function DocEditor(props: Omit<DocumentEditorProps, "maxLength">) {
  const Editor = useDocsUi().conversation.DocumentEditor;
  return (
    <Editor
      {...props}
      maxLength={MAX_DOC_BYTES}
      label="Doc body"
      placeholder="Write your doc…"
    />
  );
}

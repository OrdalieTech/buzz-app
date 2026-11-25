import type { Ref } from "react";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./DocsPage.module.css";

export function DocTitle({
  value,
  onValueChange,
  placeholder,
  readOnly,
  disabled,
  ref,
}: {
  value: string;
  onValueChange(value: string): void;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  ref: Ref<HTMLTextAreaElement>;
}) {
  return (
    <Field label="Title" labelVisibility="hidden">
      <div className={styles.titleField} data-title={value || placeholder}>
        <Textarea
          ref={ref}
          appearance="heading"
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          readOnly={readOnly}
          disabled={disabled}
          tabIndex={readOnly ? -1 : undefined}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing)
              event.preventDefault();
          }}
        />
      </div>
    </Field>
  );
}

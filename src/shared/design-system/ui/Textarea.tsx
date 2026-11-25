import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps } from "react";

export type TextareaProps = Omit<ComponentProps<"textarea">, "className">;
/** Field.Control supplies the same label/validation behavior as Input. */
export function Textarea({
  variant = "text",
  surface = "inset",
  appearance = "field",
  id,
  name,
  value,
  defaultValue,
  disabled,
  autoFocus,
  ref,
  ...props
}: TextareaProps & {
  variant?: "text" | "code";
  surface?: "inset" | "panel";
  /** Outlined fields and inline headings replace the default inset fill. */
  appearance?: "field" | "outlined" | "heading";
}) {
  return (
    <BaseField.Control
      id={id}
      name={name}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      autoFocus={autoFocus}
      ref={ref}
      render={
        <textarea
          autoCorrect={variant === "code" ? "off" : undefined}
          autoCapitalize={variant === "code" ? "none" : undefined}
          spellCheck={variant === "code" ? false : undefined}
          {...props}
        />
      }
      data-buzz-ui=""
      className="buzz-textarea"
      data-variant={variant}
      data-surface={surface}
      data-appearance={appearance}
    />
  );
}

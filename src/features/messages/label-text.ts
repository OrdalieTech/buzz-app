import { Children, isValidElement, type ReactNode } from "react";

/** Plain text of rendered Markdown children, such as a formatted link label. */
export const labelText = (children: ReactNode): string =>
  Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? labelText(child.props.children)
        : String(child),
    )
    .join("");

import type { ComponentProps, ElementType, ReactNode } from "react";

type PanelProps<T extends ElementType> = {
  as?: T;
  children?: ReactNode;
  joined?: boolean;
  shape?: "panel" | "capsule" | "card";
} & Omit<ComponentProps<T>, "as" | "children" | "className">;

/**
 * An independently legible workspace surface.
 *
 * Panel owns only the rounded surface: its fill, border, shadow, and clipping.
 * `joined` makes nested panels flush regions of this single outer surface;
 * layout owners supply the dividers between those regions.
 * Its marker does not suppress host defaults for native product/plugin content.
 * It owns neither a header nor content — those are composed into it by the
 * product surface that knows what belongs there. An empty Panel is therefore a
 * complete and valid specimen of this component.
 *
 * Resizing is deliberately not a Panel concern. A panel can sit in ordinary
 * layout, a future fixed composition, or a DockWorkspace; the workspace owns
 * live geometry, its resize seams, and their persistence policy. Asking Panel
 * to demonstrate a resizable arrangement would make a layout owner look like a
 * surface owner.
 */
export function Panel<T extends ElementType = "section">({
  as,
  children,
  joined,
  shape = "panel",
  ...props
}: PanelProps<T>) {
  const Component = as ?? "section";
  return (
    <Component
      {...props}
      data-buzz-surface=""
      data-joined={joined || undefined}
      data-shape={shape}
      className="panel"
    >
      {children}
    </Component>
  );
}

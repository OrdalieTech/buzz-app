import { useMemo, useState, type ComponentProps } from "react";
import type { BrowserIcon } from "../../shared/design-system/icons/index";

type PageIconProps = {
  icon: typeof BrowserIcon;
  image?: string | undefined;
  size: number;
  strokeWidth?: ComponentProps<typeof BrowserIcon>["strokeWidth"];
};

const pixelsPerRem = 16;
const svgData = /^data:image\/svg\+xml((?:;[^,]*)?),/i;
const nonPaint = /<!--[\s\S]*?-->|<(title|desc|metadata)\b[\s\S]*?<\/\1\s*>/gi;
const currentColorPaint =
  /(?:^|[\s;"'{])(?:fill|stroke|stop-color|flood-color|lighting-color)\s*(?:=\s*["']?|:)\s*currentcolor\b/i;

/** An SVG that paints with `currentColor`, which an `<img>` can't resolve. */
export function paintsCurrentColor(image: string): boolean {
  const match = svgData.exec(image);
  if (!match) return false;
  const payload = image.slice(match[0].length);
  try {
    const svg = /;base64$/i.test(match[1] ?? "")
      ? atob(payload)
      : decodeURIComponent(payload);
    return currentColorPaint.test(svg.replace(nonPaint, ""));
  } catch {
    return false;
  }
}

const cssUrl = (image: string) =>
  `url("${image.replace(/["\\\n\r]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)}")`;

/**
 * Shows a page's declared image, or `icon` when there is none or the image
 * fails to load. A failed source stays on `icon`; a new source gets one attempt.
 * An SVG that paints with `currentColor` is drawn as a mask in the text colour,
 * so it follows the theme and the row's hover and selected states like `icon`.
 * `strokeWidth` applies to `icon` only.
 */
export function PageIcon({
  icon: Icon,
  image,
  size,
  strokeWidth,
}: PageIconProps) {
  const [failedImage, setFailedImage] = useState<string>();
  const tinted = useMemo(
    () => image !== undefined && paintsCurrentColor(image),
    [image],
  );
  if (image !== undefined && image !== failedImage) {
    const length = `${size / pixelsPerRem}rem`;
    if (tinted) {
      const mask = cssUrl(image);
      return (
        <span
          aria-hidden="true"
          className="inline-block shrink-0 bg-current"
          style={{
            width: length,
            height: length,
            maskImage: mask,
            WebkitMaskImage: mask,
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        >
          {/* A mask reports no load failure, so a hidden copy watches for one. */}
          <img
            src={image}
            alt=""
            hidden
            onError={() => setFailedImage(image)}
          />
        </span>
      );
    }
    return (
      <img
        src={image}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="object-contain"
        style={{ width: length, height: length }}
        onError={() => setFailedImage(image)}
      />
    );
  }
  return (
    <Icon
      size={size}
      aria-hidden="true"
      {...(strokeWidth === undefined ? {} : { strokeWidth })}
    />
  );
}

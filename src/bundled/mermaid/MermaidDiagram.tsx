import { useEffect, useRef, useState } from "react";
import type { MountOptions } from "pele/lazy";
import styles from "./Mermaid.module.css";

// Diagrams are untrusted message content: no navigation out of the
// conversation and no network fetches. Pele's zoom buttons would bypass the
// shared controls, so the inline diagram scales to fit and the expanded one
// zooms by gesture and keyboard only.
// Drawing runs on the main thread, and Pele's 4M-character output default
// admits SVGs with tens of thousands of elements. Only the output length
// bounds what gets drawn, so cap it well above real diagrams: a 150-node
// flowchart draws about 80k characters.
const inline: MountOptions = {
  links: false,
  images: false,
  zoom: false,
  outputLimit: 250_000,
};
const expandedOptions: MountOptions = {
  ...inline,
  zoom: { always: true, controls: false },
};

export function MermaidDiagram({
  code,
  expanded = false,
}: {
  code: string;
  expanded?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<{ code: string; message: string }>();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let live = true;
    let diagram: { destroy(): void } | undefined;
    const fail = (message = "This diagram couldn't be drawn.") => {
      if (!live) return;
      element.replaceChildren();
      setFailure({ code, message });
    };
    // Labels follow the message text size, including enlarged text.
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    void import("pele/lazy").then(
      async ({ detectType, load, mount, PeleError }) => {
        // Pele's messages are plain text written for display.
        const reject = (error: unknown) =>
          fail(error instanceof PeleError ? error.message : undefined);
        try {
          await load(detectType(code));
          // Draw only while current, so a slower earlier load never
          // overwrites an edited diagram.
          if (live)
            diagram = mount(element, code, {
              ...(expanded ? expandedOptions : inline),
              ...(fontSize > 0 && { fontSize }),
              onError: reject,
            });
        } catch (error) {
          reject(error);
        }
      },
      () => fail(),
    );
    return () => {
      live = false;
      diagram?.destroy();
    };
  }, [code, expanded]);
  const message = failure?.code === code ? failure.message : undefined;
  return (
    <>
      <div ref={container} className={styles.diagram} hidden={!!message} />
      {message && (
        <>
          {/* Not <pre>: the host frame already surrounds this content. */}
          <div className={styles.error}>{message}</div>
          <div className={styles.source}>{code}</div>
        </>
      )}
    </>
  );
}

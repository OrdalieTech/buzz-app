import { ScrollEdgeMaterial } from "./ScrollEdgeMaterial";

/** Shared progressive blur and surface fade behind dialog chrome.
 * Hosts place the material; the shared dialog recipe owns its optical layers. */
export function DialogBarMaterial({
  className = "",
}: {
  className?: string | undefined;
}) {
  return (
    <ScrollEdgeMaterial
      edge="top"
      className={`buzz-dialog-bar-material ${className}`}
    />
  );
}

// Display fitting and capture-rect validation for the native thread-scroll harness.

// Reference window geometry on a main display large enough to hold it.
export const REFERENCE_WINDOW = { x: 18, y: 51, width: 1504, height: 916 };
export const MIN_WINDOW = { width: 1280, height: 700 };

const ceilEven = (value) => Math.ceil(value / 2) * 2;
const floorEven = (value) => Math.floor(value / 2) * 2;

export function fitWindow(screen, preferred = REFERENCE_WINDOW) {
  const vx = Math.ceil(screen.visible.x);
  const vy = Math.ceil(screen.visible.y);
  const vw = Math.floor(screen.visible.x + screen.visible.width) - vx;
  const vh = Math.floor(screen.visible.y + screen.visible.height) - vy;
  if (vw < MIN_WINDOW.width || vh < MIN_WINDOW.height) {
    throw new Error(
      `Main display usable area ${vw}x${vh} is below the ${MIN_WINDOW.width}x${MIN_WINDOW.height} minimum`,
    );
  }
  const width = Math.min(preferred.width, vw);
  const height = Math.min(preferred.height, vh);
  // Shift inside the usable area before shrinking, so a display slightly
  // narrower than x + width (e.g. 1512px wide) keeps the full reference width.
  const x = Math.max(vx, Math.min(preferred.x, vx + vw - width));
  const y = Math.max(vy, Math.min(preferred.y, vy + vh - height));
  return {
    x,
    y,
    width,
    height,
    fitted: width !== preferred.width || height !== preferred.height,
  };
}

export function threadCapture(actualWindow, threadRect, screen, dpr) {
  if (!Number.isFinite(dpr) || Math.abs(dpr - screen.scale) > 0.01) {
    throw new Error(
      `Window DPR (${dpr}) does not match main display scale (${screen.scale})`,
    );
  }
  const [wx, wy] = actualWindow;
  const [tx, ty, tw, th] = threadRect;
  const left = wx + tx;
  const top = wy + ty;
  const right = left + tw;
  const bottom = top + th;
  const vLeft = screen.visible.x;
  const vTop = screen.visible.y;
  const vRight = vLeft + screen.visible.width;
  const vBottom = vTop + screen.visible.height;
  if (
    tw <= 0 ||
    th <= 0 ||
    left < vLeft ||
    top < vTop ||
    right > vRight ||
    bottom > vBottom
  ) {
    throw new Error(
      `Thread pane [${left.toFixed(1)}, ${top.toFixed(1)}, ${right.toFixed(1)}, ${bottom.toFixed(1)}] extends outside visible display [${vLeft}, ${vTop}, ${vRight}, ${vBottom}]`,
    );
  }
  // Round all four edges inward to even pixels: NV12 (yuv420) rounds odd crop
  // origins down, which would otherwise admit a pixel column from beside the pane.
  const cropX = ceilEven(left * dpr);
  const cropY = ceilEven(top * dpr);
  const cropRight = floorEven(right * dpr);
  const cropBottom = floorEven(bottom * dpr);
  const cropW = cropRight - cropX;
  const cropH = cropBottom - cropY;
  if (cropW <= 0 || cropH <= 0) {
    throw new Error(
      `Computed crop ${cropW}x${cropH}+${cropX}+${cropY} is empty`,
    );
  }
  return {
    crop: { x: cropX, y: cropY, width: cropW, height: cropH },
    focus: [Math.round(right) - 12, Math.round(top + th * 0.55)],
    center: [Math.round(left + tw / 2), Math.round(top + th / 2)],
  };
}

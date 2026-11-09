import { useEffect, useRef } from "react";
import styles from "./IdentitySetup.module.css";

const BEE_IDS = Array.from({ length: 50 }, (_, i) => `welcome-bee-${i}`);
const TAU = Math.PI * 2;
const wrap = (angle: number) => ((angle + Math.PI * 3) % TAU) - Math.PI;

/** Decorative mobile welcome bees; no React renders in the animation loop. */
export function OnboardingBees({ entering = false }: { entering?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const area = root.current;
    if (
      !area?.parentElement ||
      typeof matchMedia !== "function" ||
      typeof ResizeObserver !== "function"
    )
      return;
    const parent = area.parentElement;
    const elements = Array.from(area.children) as HTMLElement[];
    let width = area.clientWidth;
    let height = area.clientHeight;
    let pointer: { x: number; y: number } | undefined;
    const bees = elements.map((_, index) => {
      const seed = ((index + 1) * 0.7548776662) % 1;
      const x = (0.5 + (index + 1) / 1.324717957244746) % 1;
      const y = (0.5 + (index + 1) / 1.324717957244746 ** 2) % 1;
      return {
        seed,
        x: x * width,
        y: y * height,
        homeX: 0.12 + x * 0.76,
        homeY: 0.14 + y * 0.72,
        vx: 0,
        vy: 0,
        heading: seed * TAU,
        rotation: seed * TAU + Math.PI / 2,
      };
    });
    const paint = () =>
      bees.forEach((bee, index) => {
        const element = elements[index];
        if (!element) return;
        element.style.transform = `translate(${bee.x}px, ${bee.y}px) rotate(${bee.rotation}rad)`;
      });
    const edge = (value: number, extent: number) =>
      value < 110
        ? 1 - value / 110
        : value > extent - 110
          ? -(1 - (extent - value) / 110)
          : 0;
    let elapsed = 0;
    const advance = () => {
      const dt = 1 / 60;
      elapsed += dt;
      const positions = bees.map(({ x, y }) => ({ x, y }));
      bees.forEach((bee, index) => {
        const { seed, x, y } = bee;
        const ex = edge(x, width),
          ey = edge(y, height);
        bee.heading +=
          (Math.sin(elapsed * (0.27 + seed * 0.4) + seed * TAU) +
            0.6 * Math.sin(elapsed * (0.13 + seed * 0.11) + seed * 7)) *
          1.15 *
          dt;
        if (ex || ey)
          bee.heading +=
            wrap(Math.atan2(ey, ex) - bee.heading) *
            3.2 *
            Math.min(1, Math.hypot(ex, ey)) *
            dt;
        const phase = (elapsed * (0.24 + seed * 0.2) + seed * 5.37) % 1;
        const burst = phase < 0.18 ? Math.sin((phase / 0.18) * Math.PI) : 0;
        const speed = Math.max(
          58 * 0.46,
          58 *
            (1 + Math.sin(elapsed * (0.42 + seed * 0.28) + seed * TAU) * 0.32) +
            width * 1.1 * burst,
        );
        bee.vx +=
          (Math.cos(bee.heading) * speed - bee.vx) * (2.4 + 11 * burst) * dt;
        bee.vy +=
          (Math.sin(bee.heading) * speed - bee.vy) * (2.4 + 11 * burst) * dt;
        const repel = (
          other: { x: number; y: number },
          radius: number,
          force: number,
        ) => {
          const dx = x - other.x,
            dy = y - other.y,
            distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < radius) {
            const amount = ((force * (1 - distance / radius)) / distance) * dt;
            bee.vx += dx * amount;
            bee.vy += dy * amount;
          }
        };
        positions.forEach((other, i) => {
          if (i !== index) repel(other, 66, 1300);
        });
        if (pointer) repel(pointer, 380, 1600);
        bee.vx =
          (bee.vx + (bee.homeX * width - x) * 0.18 * dt + ex * 900 * dt) * 0.97;
        bee.vy =
          (bee.vy + (bee.homeY * height - y) * 0.18 * dt + ey * 900 * dt) *
          0.97;
        const nx = x + bee.vx * dt,
          ny = y + bee.vy * dt;
        if (nx < 0 || nx > width) bee.vx *= -0.5;
        if (ny < 0 || ny > height) bee.vy *= -0.5;
        bee.x = Math.max(0, Math.min(width, nx));
        bee.y = Math.max(0, Math.min(height, ny));
        if (Math.hypot(bee.vx, bee.vy) > 6)
          bee.rotation +=
            wrap(Math.atan2(bee.vy, bee.vx) + Math.PI / 2 - bee.rotation) *
            0.18;
      });
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0,
      previous = 0,
      remainder = 0;
    const tick = (now: number) => {
      remainder += previous ? Math.min((now - previous) / 1000, 0.05) : 0;
      previous = now;
      while (remainder >= 1 / 60) {
        advance();
        remainder -= 1 / 60;
      }
      paint();
      frame = requestAnimationFrame(tick);
    };
    const play = () => {
      cancelAnimationFrame(frame);
      previous = 0;
      remainder = 0;
      if (width > 0 && height > 0 && !reduced.matches && !document.hidden)
        frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(() => {
      const nextWidth = area.clientWidth,
        nextHeight = area.clientHeight;
      bees.forEach((bee) => {
        bee.x *= nextWidth / Math.max(1, width);
        bee.y *= nextHeight / Math.max(1, height);
      });
      width = nextWidth;
      height = nextHeight;
      pointer = undefined;
      paint();
      play();
    });
    const move = (event: PointerEvent) => {
      const bounds = area.getBoundingClientRect();
      pointer = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
    };
    const leave = () => {
      pointer = undefined;
    };
    parent.addEventListener("pointermove", move);
    parent.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", play);
    reduced.addEventListener("change", play);
    resize.observe(area);
    paint();
    play();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      parent.removeEventListener("pointermove", move);
      parent.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", play);
      reduced.removeEventListener("change", play);
    };
  }, []);
  return (
    <div ref={root} className={styles.bees} aria-hidden="true">
      {BEE_IDS.map((id) => (
        <span key={id} className={styles.bee}>
          <span className={entering ? styles.beeArrival : undefined} />
        </span>
      ))}
    </div>
  );
}

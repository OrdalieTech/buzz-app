// Phone behaviour for the web build, below the app's own 650px breakpoint
// (AppShell's narrow drawer layout): on-screen keyboard, drawer gestures,
// long-press actions, swipe to reply, haptics and reload into a new build.
// Layout lives in mobile.css. Lessons from the previous PWA: never
// pushState/history.back from here, press feedback is opacity only.
import "./mobile.css";

const phone = matchMedia("(max-width: 650px)");
const touch = matchMedia("(pointer: coarse)");
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const ROW = "[data-message-id]:not([data-membership-row])";
const DRAWER = '#shell-navigation[data-expanded="true"]';
const TEXT_INPUT =
  'textarea, [contenteditable="true"], input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"]';
const root = document.documentElement;
// Every touch event this file handles carries at least one touch.
const first = (touches: TouchList) => touches[0] as Touch;

// A tick like native controls, `ms` long on Android (Chrome mutes it in
// silent mode). iOS has no Vibration API but ticks when a switch toggles,
// so it clicks a hidden one; its tick has a single strength.
let lastHaptic = 0;
function haptic(ms: number) {
  if (!touch.matches || performance.now() - lastHaptic < 60) return;
  lastHaptic = performance.now();
  if (navigator.vibrate) {
    navigator.vibrate(ms);
    return;
  }
  const label = document.createElement("label");
  label.ariaHidden = "true";
  label.style.display = "none";
  label.innerHTML = '<input type="checkbox" switch>';
  document.head.append(label);
  label.click();
  label.remove();
}

// Whether a touch lands on something that scrolls sideways (code blocks,
// wide tables, tab strips), which keeps the gesture for itself.
function scrollsSideways(el: Element | null, until?: Element) {
  for (; el && el !== until && el !== document.body; el = el.parentElement)
    if (
      el.scrollWidth > el.clientWidth &&
      /auto|scroll/.test(getComputedStyle(el).overflowX)
    )
      return true;
  return false;
}

// iOS zooms into any field under 16px on focus; maximum-scale stops that and
// iOS still lets people pinch-zoom. Android would lose pinch-zoom, and
// doesn't zoom on focus, so it's iOS only (iPads report Mac).
if (
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent))
) {
  const meta = document.querySelector('meta[name="viewport"]');
  meta?.setAttribute(
    "content",
    `${meta.getAttribute("content")}, maximum-scale=1`,
  );
}

// The shell is h-dvh, which iOS never shrinks for the keyboard (Android does,
// with interactive-widget=resizes-content). Pin the shell to the visual
// viewport so the keyboard raises the composer instead of covering it.
const viewport = window.visualViewport;
if (viewport) {
  // Tallest height seen per width: the keyboard is whatever eats into it.
  const fullHeight = new Map<number, number>();
  const sync = () => {
    if (viewport.scale > 1.01) return; // pinch zoom: keep the last layout
    const width = Math.round(viewport.width);
    const full = Math.max(fullHeight.get(width) ?? 0, viewport.height);
    fullHeight.set(width, full);
    root.style.setProperty("--buzz-viewport-height", `${viewport.height}px`);
    root.style.setProperty("--buzz-viewport-top", `${viewport.offsetTop}px`);
    root.toggleAttribute("data-keyboard-open", full - viewport.height > 150);
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  sync();
}

// Tapping send would move focus to the button and drop the keyboard after
// every message. Keep focus in the editor and click for the tap instead.
document.addEventListener(
  "touchend",
  (event) => {
    const send = (event.target as Element).closest<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    );
    const point = first(event.changedTouches);
    if (
      !phone.matches ||
      !send ||
      send.disabled ||
      !send.closest("form")?.contains(document.activeElement) ||
      !send.contains(document.elementFromPoint(point.clientX, point.clientY))
    )
      return;
    event.preventDefault();
    send.click();
  },
  { capture: true },
);

// The drawer follows the finger: swipe right on a screen to pull it open,
// swipe it left to put it away; release settles by position or flick. The
// shell's own toggle opens and closes it, so React keeps the state.
{
  const toggle = () =>
    document.querySelector<HTMLElement>("[data-shell-sidebar-toggle]");
  let pan: {
    x: number;
    y: number;
    axis: "x" | "y" | null;
    opening: boolean;
    offset: number;
    velocity: number;
    lastX: number;
    lastT: number;
  } | null = null;
  const place = (drawer: HTMLElement, offset: number | null, ms = 0) => {
    drawer.style.transition = offset == null ? "" : `transform ${ms}ms ${EASE}`;
    drawer.style.transform = offset == null ? "" : `translateX(${offset}px)`;
    drawer.style.setProperty(
      "--buzz-scrim",
      offset == null ? "" : String(1 + offset / drawer.offsetWidth),
    );
  };
  document.addEventListener(
    "touchstart",
    (event) => {
      pan = null;
      if (!phone.matches || event.touches.length > 1 || !toggle()) return;
      const target = event.target as Element;
      const open = !!document.querySelector(DRAWER);
      if (
        !open &&
        (document.querySelector('[role="dialog"], [role="menu"]') ||
          target.closest(`${TEXT_INPUT}, form`) ||
          scrollsSideways(target))
      )
        return;
      const point = first(event.touches);
      pan = {
        x: point.clientX,
        y: point.clientY,
        axis: null,
        opening: !open,
        offset: 0,
        velocity: 0,
        lastX: point.clientX,
        lastT: event.timeStamp,
      };
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!pan) return;
      const point = first(event.touches);
      const dx = point.clientX - pan.x;
      if (!pan.axis) {
        if (Math.hypot(dx, point.clientY - pan.y) < 10) return;
        pan.axis = Math.abs(dx) > Math.abs(point.clientY - pan.y) ? "x" : "y";
        if (pan.axis === "y" || (pan.opening ? dx < 0 : dx > 0)) {
          pan = null;
          return;
        }
        if (pan.opening) toggle()?.click();
      }
      pan.velocity =
        (point.clientX - pan.lastX) / (event.timeStamp - pan.lastT || 1);
      pan.lastX = point.clientX;
      pan.lastT = event.timeStamp;
      const drawer = document.querySelector<HTMLElement>(DRAWER);
      if (!drawer) return;
      const width = drawer.offsetWidth;
      pan.offset = Math.max(-width, Math.min(0, pan.opening ? dx - width : dx));
      place(drawer, pan.offset);
    },
    { capture: true, passive: true },
  );
  const release = () => {
    const done = pan;
    pan = null;
    const drawer = document.querySelector<HTMLElement>(DRAWER);
    if (done?.axis !== "x" || !drawer) return;
    const { offset, velocity } = done;
    const open =
      Math.abs(velocity) > 0.3
        ? velocity > 0
        : offset > -drawer.offsetWidth / 2;
    haptic(8);
    place(drawer, open ? 0 : -drawer.offsetWidth, 200);
    window.setTimeout(() => {
      place(drawer, null);
      if (!open) toggle()?.click();
    }, 200);
  };
  document.addEventListener("touchend", release, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchcancel", release, {
    capture: true,
    passive: true,
  });
  // The scrim is the drawer's own ::after: a tap on it closes the drawer.
  document.addEventListener(
    "click",
    (event) => {
      if ((event.target as Element).matches?.(DRAWER)) toggle()?.click();
    },
    { capture: true },
  );
}

// On touch, upstream keeps every message's action bar on screen. Phones
// show them on long press instead, like a native chat app.
{
  let timer = 0;
  let origin: { x: number; y: number } | null = null;
  // A long press is not a tap: drop the click some browsers still send.
  let swallowClick = false;
  const reveal = (row: Element | null) => {
    for (const active of document.querySelectorAll("[data-touch-actions]"))
      if (active !== row) active.removeAttribute("data-touch-actions");
    row?.setAttribute("data-touch-actions", "");
  };
  document.addEventListener(
    "touchstart",
    (event) => {
      swallowClick = false;
      const target = event.target as Element;
      if (target.closest('[aria-label="Message actions"], [role="menu"]'))
        return;
      reveal(null);
      const row = target.closest(ROW);
      if (!row || !phone.matches) return;
      const point = first(event.touches);
      origin = { x: point.clientX, y: point.clientY };
      timer = window.setTimeout(() => {
        reveal(row);
        haptic(20);
        origin = null;
        swallowClick = true;
      }, 420);
    },
    { passive: true },
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      const point = first(event.touches);
      if (
        origin &&
        Math.hypot(point.clientX - origin.x, point.clientY - origin.y) > 10
      ) {
        window.clearTimeout(timer);
        origin = null;
      }
    },
    { passive: true },
  );
  for (const type of ["touchend", "touchcancel"])
    document.addEventListener(type, () => window.clearTimeout(timer), {
      passive: true,
    });
}

// Swipe a message left to reply: the row follows the finger, ticks past the
// threshold, springs back and opens the reply with the keyboard up.
{
  const THRESHOLD = 56;
  let swipe: {
    row: HTMLElement;
    x: number;
    y: number;
    dx: number;
    axis: "x" | "y" | null;
  } | null = null;
  const settle = (row: HTMLElement) => {
    row.style.transition = `transform 220ms ${EASE}`;
    row.style.transform = "";
    window.setTimeout(() => (row.style.transition = ""), 240);
  };
  document.addEventListener(
    "touchstart",
    (event) => {
      const point = first(event.touches);
      const row = (event.target as Element).closest<HTMLElement>(ROW);
      swipe =
        phone.matches &&
        row?.querySelector('button[aria-label="Reply"]:enabled') &&
        event.touches.length === 1 &&
        !scrollsSideways(event.target as Element, row)
          ? { row, x: point.clientX, y: point.clientY, dx: 0, axis: null }
          : null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!swipe) return;
      const point = first(event.touches);
      const dx = point.clientX - swipe.x;
      if (!swipe.axis) {
        if (Math.hypot(dx, point.clientY - swipe.y) < 10) return;
        swipe.axis =
          Math.abs(dx) > Math.abs(point.clientY - swipe.y) && dx < 0
            ? "x"
            : "y";
      }
      if (swipe.axis === "y") return;
      // Past the threshold the row resists, as native swipe actions do.
      const pull = -dx;
      const offset = -(pull < THRESHOLD
        ? Math.max(0, pull)
        : THRESHOLD + (pull - THRESHOLD) / 4);
      if (-swipe.dx < THRESHOLD !== -offset < THRESHOLD) haptic(12);
      swipe.dx = offset;
      swipe.row.style.transform = `translateX(${offset}px)`;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchend",
    () => {
      const done = swipe;
      swipe = null;
      if (done?.axis !== "x") return;
      settle(done.row);
      if (-done.dx < THRESHOLD) return;
      haptic(15);
      // The keyboard only opens from focus inside the gesture, before the
      // reply composer exists: focus a stand-in now, then hand focus over.
      const standIn = document.createElement("input");
      standIn.ariaHidden = "true";
      standIn.style.cssText =
        "position:fixed;top:0;opacity:0;height:1px;font-size:16px"; // 16px: no iOS zoom
      document.body.append(standIn);
      standIn.focus();
      done.row
        .querySelector<HTMLElement>('button[aria-label="Reply"]')
        ?.click();
      window.setTimeout(() => {
        if (document.activeElement === standIn)
          [
            ...document.querySelectorAll<HTMLElement>(
              'form [contenteditable="true"]',
            ),
          ]
            .at(-1)
            ?.focus();
        standIn.remove();
      }, 350);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchcancel",
    () => {
      if (swipe) settle(swipe.row);
      swipe = null;
    },
    { passive: true },
  );
}

// Taps on the controls people use most tick like native ones: a firmer one
// for sending, a light one for reactions, replies, choices and navigation.
const TAP_TICKS: [string, number][] = [
  ['button[aria-label="Send message"]', 15],
  [
    '[aria-label="Message actions"] button, [data-message-reactions] button',
    10,
  ],
  [
    '[role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], [data-shell-sidebar-toggle]',
    8,
  ],
];
document.addEventListener(
  "click",
  (event) => {
    const target = event.target as Element;
    const tick = TAP_TICKS.find(([selector]) => target.closest?.(selector));
    if (tick) haptic(tick[1]);
  },
  { capture: true, passive: true },
);

// An installed app can stay open for days. When it comes back to the
// foreground after a deploy, reload into the new build, unless something is
// being typed.
{
  const current = document
    .querySelector('script[type="module"][src]')
    ?.getAttribute("src");
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !current) return;
    const html = await fetch("/", {
      headers: { Accept: "text/html" },
      cache: "no-store",
    })
      .then((response) => response.text())
      .catch(() => "");
    const next = html.match(/<script type="module"[^>]* src="([^"]+)"/)?.[1];
    if (
      next &&
      next !== current &&
      !document.activeElement?.matches(TEXT_INPUT)
    )
      location.reload();
  });
}

// Reading only counts while focus is in the conversation
// (src/features/messages/use-reading.ts). On desktop a channel opens into its
// composer; on touch nothing takes focus, so nothing was ever marked read.
// Hand focus to the message list, which takes it without raising the keyboard.
{
  const LIST = "[data-message-scroller]";
  const read = (target?: EventTarget | null) => {
    if (!touch.matches || document.querySelector(DRAWER)) return;
    const active = document.activeElement;
    if (active?.matches(TEXT_INPUT) || active?.closest(LIST)) return;
    const list =
      (target as Element | null)?.closest?.<HTMLElement>(LIST) ??
      [...document.querySelectorAll<HTMLElement>(LIST)]
        .filter(
          (el) =>
            el.getClientRects().length &&
            !el.closest('[inert], [hidden], [aria-hidden="true"]'),
        )
        .at(-1);
    list?.focus({ preventScroll: true });
  };
  // After the tap's own navigation and render.
  const soon = (event: Event) => setTimeout(() => read(event.target), 400);
  for (const type of ["click", "hashchange", "popstate"])
    addEventListener(type, soon, { passive: true });
  document.addEventListener("visibilitychange", (event) => {
    if (document.visibilityState === "visible") soon(event);
  });
}

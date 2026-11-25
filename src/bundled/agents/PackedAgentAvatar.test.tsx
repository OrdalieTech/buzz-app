// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
const motion = new EventTarget() as EventTarget & { matches: boolean };
let visibility: IntersectionObserverCallback;
beforeEach(() => {
  motion.matches = false;
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(prefers-reduced-motion: reduce)");
    return motion;
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
function showAvatar() {
  visibility(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setReducedMotion(matches: boolean) {
  act(() => {
    motion.matches = matches;
    motion.dispatchEvent(new Event("change"));
  });
}
it.each([
  ["MacIntel", "AppleWebKit Safari", ".mp4"],
  ["iPhone", "AppleWebKit Safari", ".mp4"],
  ["MacIntel", "AppleWebKit Chrome", ".webm"],
  ["Linux x86_64", "AppleWebKit Safari", ".webm"],
  ["Linux aarch64", "AppleWebKit Safari", ".webm"],
  ["Win32", "AppleWebKit Chrome", ".webm"],
])(
  "plays the selected animation on %s / %s and falls back on failure",
  (platform, userAgent, extension) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    const avatar = agentAvatars[0];
    if (!avatar) throw new Error("Missing fixture avatar");
    const view = render(<PackedAgentAvatar avatar={avatar} />);
    const video = view.container.querySelector("video");
    if (!video) throw new Error("Missing selected animation");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video).toHaveAttribute("playsinline");
    expect(video.querySelectorAll("source")).toHaveLength(2);
    expect(video.querySelector("source")?.src).toContain(extension);
    fireEvent.error(video);
    expect(screen.getByRole("img", { name: avatar.label })).toHaveAttribute(
      "src",
      avatar.preview,
    );
    const next = agentAvatars[1];
    if (!next) throw new Error("Missing second fixture avatar");
    view.rerender(<PackedAgentAvatar avatar={next} />);
    expect(view.container.querySelector("video")).not.toBeNull();
  },
);
it("uses a still poster for reduced motion without loading video", () => {
  motion.matches = true;
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  expect(view.container.querySelector("video")).toBeNull();
  expect(screen.getByRole("img", { name: avatar.label })).toBeVisible();
});

it("follows a reduced-motion change while mounted", () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  const video = view.container.querySelector("video");
  showAvatar();
  expect(play).toHaveBeenCalledOnce();
  setReducedMotion(true);
  expect(video).not.toBeInTheDocument();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(screen.getByRole("img", { name: avatar.label })).toHaveAttribute(
    "src",
    avatar.preview,
  );
  setReducedMotion(false);
  showAvatar();
  expect(view.container.querySelector("video")).not.toBeNull();
  expect(play).toHaveBeenCalledTimes(2);
});

it("pauses while a covering pane hides it and resumes when revealed", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi.mocked(HTMLMediaElement.prototype.pause);
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const view = render(
    <div data-testid="pane">
      <PackedAgentAvatar avatar={avatar} />
    </div>,
  );
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing avatar video");
  showAvatar();
  expect(play).toHaveBeenCalledOnce();
  const pane = screen.getByTestId("pane");
  pane.setAttribute("data-covered", "");
  await waitFor(() => expect(pause).toHaveBeenCalledOnce());
  // Readiness and hover may not restart a covered avatar.
  fireEvent.canPlay(video);
  fireEvent.pointerEnter(video.parentElement as HTMLElement);
  expect(play).toHaveBeenCalledOnce();
  pane.removeAttribute("data-covered");
  await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
});

it("continues the outgoing avatar frame in the incoming video", () => {
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const outgoing = render(<PackedAgentAvatar avatar={avatar} />);
  const oldVideo = outgoing.container.querySelector("video");
  if (!oldVideo) throw new Error("Missing outgoing video");
  Object.defineProperty(oldVideo, "readyState", { value: 4 });
  Object.defineProperty(oldVideo, "paused", { value: false });
  oldVideo.currentTime = 2.5;
  const incoming = render(<PackedAgentAvatar avatar={avatar} />);
  const newVideo = incoming.container.querySelector("video");
  if (!newVideo) throw new Error("Missing incoming video");
  fireEvent.loadedData(newVideo);
  expect(newVideo.currentTime).toBe(2.5);
});

it("starts muted inline playback without native controls", () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing fixture avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing avatar video");
  showAvatar();
  expect(play).toHaveBeenCalledOnce();
  expect(video.muted).toBe(true);
  expect(video.defaultMuted).toBe(true);
  expect(video.controls).toBe(false);
  expect(video).toHaveAttribute("playsinline");
});

it("keeps animation available after autoplay is blocked and retries on hover", async () => {
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValueOnce(new DOMException("Blocked", "NotAllowedError"))
    .mockResolvedValue();
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  showAvatar();
  await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  expect(view.container.querySelector("video")).toBe(video);
  fireEvent.pointerEnter(video.parentElement as HTMLElement);
  expect(play).toHaveBeenCalledTimes(2);
});

it("streams both codecs from the CDN and falls back when the last source fails", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("AppleWebKit Safari");
  const avatar = agentAvatars[0];
  if (!avatar) throw new Error("Missing avatar");
  const view = render(<PackedAgentAvatar avatar={avatar} />);
  const sources = [...view.container.querySelectorAll("source")];
  expect(sources.map((source) => source.src)).toEqual([
    avatar.animations.hevc.url,
    avatar.animations.webm.url,
  ]);
  const last = sources.at(-1);
  if (!last) throw new Error("Missing fallback source");
  fireEvent.error(last);
  expect(screen.getByRole("img", { name: avatar.label })).toHaveAttribute(
    "src",
    avatar.preview,
  );
});

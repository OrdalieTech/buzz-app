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
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { VoiceNoteCard } from "../../bundled/voice-notes/VoiceNoteCard";
import { AudioAttachment } from "./AudioAttachment";

// No media listener: `media_stream_base` reports none.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const source = "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Faudio.mp3";
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

function setDuration(element: HTMLAudioElement, duration: number) {
  Object.defineProperty(element, "duration", {
    configurable: true,
    value: duration,
  });
}

function setPaused(element: HTMLMediaElement, paused: boolean) {
  Object.defineProperty(element, "paused", {
    configurable: true,
    value: paused,
  });
}

beforeEach(() => {
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      setPaused(this, false);
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
  pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(function (this: HTMLMediaElement) {
      setPaused(this, true);
      this.dispatchEvent(new Event("pause"));
    });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("toggles the accessible play control name", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  const playButton = screen.getByRole("button", { name: "Play audio" });
  expect(playButton).toBeInTheDocument();
  expect(playButton).toHaveAttribute("data-icon-variant", "ghost");
  expect(playButton).toHaveAttribute("data-icon-size", "sm");
  expect(playButton).toHaveAttribute("data-icon-shape", "control");
  fireEvent.play(audio);
  expect(
    screen.getByRole("button", { name: "Pause audio" }),
  ).toBeInTheDocument();
  fireEvent.pause(audio);
  expect(
    screen.getByRole("button", { name: "Play audio" }),
  ).toBeInTheDocument();
});

it("uses attachment names in audio control labels", () => {
  render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/voice-note-1.mp4",
        kind: "audio",
        name: "voice-note-1.mp4",
        duration: 83,
      }}
      source={source}
    />,
  );

  expect(
    screen.getByRole("button", { name: "Play voice-note-1.mp4" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("slider", { name: "Seek voice-note-1.mp4" }),
  ).toBeInTheDocument();
});

it("shows wire duration before metadata loads", () => {
  render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  expect(screen.getByRole("group")).toHaveTextContent("00:00 01:23");
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "83",
  );
});

it.each([
  ["normal", 95, "01:35", "95"],
  ["oversized", 1e15, "01:23", "83"],
  ["non-finite", Number.POSITIVE_INFINITY, "01:23", "83"],
])("handles %s media durations from metadata", (_case, duration, text, max) => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  setDuration(audio, duration);
  fireEvent.durationChange(audio);
  expect(screen.getByRole("group")).toHaveTextContent(`00:00 ${text}`);
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    max,
  );
});

it("keeps playback enabled while disabling seek until metadata supplies a duration", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");

  expect(screen.getByRole("group")).toHaveTextContent("00:00 —:—");
  expect(screen.getByRole("button", { name: "Play audio" })).toBeEnabled();
  expect(screen.getByRole("slider", { name: "Seek audio" })).toBeDisabled();

  setDuration(audio, 83);
  fireEvent.loadedMetadata(audio);

  expect(screen.getByRole("button", { name: "Play audio" })).toBeEnabled();
  expect(screen.getByRole("slider", { name: "Seek audio" })).toBeEnabled();
  expect(screen.getByRole("group")).toHaveTextContent("00:00 01:23");
});

it.each([
  ["before duration is known", undefined, "0:42"],
  ["with a known duration", 83, "0:42 of 1:23"],
])(
  "updates slider value text from playback time %s",
  (_case, duration, text) => {
    const { container } = render(
      <AudioAttachment
        attachment={{
          url: "https://fixture.test/audio.mp3",
          kind: "audio",
          ...(duration === undefined ? {} : { duration }),
        }}
        source={source}
      />,
    );
    const audio = container.querySelector("audio");
    if (!audio) throw new Error("Missing audio element");
    audio.currentTime = 42;
    fireEvent.timeUpdate(audio);
    expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
      "aria-valuetext",
      text,
    );
  },
);

it("sets currentTime when the seek slider changes", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 83,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  fireEvent.change(screen.getByRole("slider", { name: "Seek audio" }), {
    target: { value: "17" },
  });
  expect(audio.currentTime).toBe(17);
});

it("allows sub-second seeking to the end of non-integer durations", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 5.4,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  const slider = screen.getByRole("slider", { name: "Seek audio" });

  expect(slider).toHaveAttribute("max", "5.4");
  expect(slider).toHaveAttribute("step", "any");

  fireEvent.change(slider, { target: { value: "5.4" } });
  expect(audio.currentTime).toBe(5.4);
  expect(slider).toHaveValue("5.4");

  fireEvent.change(slider, { target: { value: "2.75" } });
  expect(audio.currentTime).toBe(2.75);
});

it("completes progress, resets the play label, and releases playback when audio ends", () => {
  const { container } = render(
    <>
      <AudioAttachment
        attachment={{
          url: "https://fixture.test/one.mp3",
          kind: "audio",
          duration: 5.4,
        }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
      />
      <AudioAttachment
        attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
      />
    </>,
  );
  const [ended, next] = Array.from(container.querySelectorAll("audio"));
  if (!ended || !next) throw new Error("Missing audio elements");

  fireEvent.play(ended);
  ended.currentTime = 5.4;
  fireEvent.ended(ended);

  expect(screen.getAllByRole("group")[0]).toHaveTextContent("00:05 00:05");
  expect(
    screen.getAllByRole("button", { name: "Play audio" })[0],
  ).toBeInTheDocument();

  fireEvent.play(next);
  expect(pause).not.toHaveBeenCalled();
});

it("keeps ended cleanup idempotent when pause fires before ended", () => {
  const { container } = render(
    <>
      <AudioAttachment
        attachment={{
          url: "https://fixture.test/one.mp3",
          kind: "audio",
          duration: 5.4,
        }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
      />
      <AudioAttachment
        attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
      />
    </>,
  );
  const [ended, next] = Array.from(container.querySelectorAll("audio"));
  if (!ended || !next) throw new Error("Missing audio elements");

  fireEvent.play(ended);
  fireEvent.pause(ended);
  ended.currentTime = 5.4;
  fireEvent.ended(ended);
  fireEvent.play(next);

  expect(
    screen.getAllByRole("button", { name: "Play audio" })[0],
  ).toBeInTheDocument();
  expect(screen.getAllByRole("group")[0]).toHaveTextContent("00:05 00:05");
  expect(pause).not.toHaveBeenCalled();
});

it("does not correct duration or suppress later duration sync when ended far before the known duration", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/truncated.mp3",
        kind: "audio",
        duration: 60,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");

  fireEvent.play(audio);
  audio.currentTime = 2;
  fireEvent.ended(audio);

  expect(screen.getByRole("group")).toHaveTextContent("01:00 01:00");
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "60",
  );

  setDuration(audio, 62);
  fireEvent.durationChange(audio);
  expect(screen.getByRole("group")).toHaveTextContent("01:00 01:02");
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "62",
  );
});

it("corrects duration to the observed end without resetting it on replay", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/voice-note.mp4",
        kind: "audio",
        duration: 5.4,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");

  fireEvent.play(audio);
  audio.currentTime = 4.6;
  fireEvent.ended(audio);

  expect(screen.getByRole("group")).toHaveTextContent("00:04 00:04");
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "4.6",
  );

  setDuration(audio, 5.4);
  fireEvent.durationChange(audio);
  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "4.6",
  );

  audio.currentTime = 0;
  fireEvent.play(audio);
  expect(
    screen.getByRole("button", { name: "Pause audio" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("group")).toHaveTextContent("00:00 00:04");
});

it("does not correct duration on a normal mid-clip pause and seek", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{
        url: "https://fixture.test/audio.mp3",
        kind: "audio",
        duration: 5.4,
      }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");

  fireEvent.change(screen.getByRole("slider", { name: "Seek audio" }), {
    target: { value: "2.75" },
  });
  fireEvent.pause(audio);

  expect(screen.getByRole("slider", { name: "Seek audio" })).toHaveAttribute(
    "max",
    "5.4",
  );
  expect(screen.getByRole("group")).toHaveTextContent("00:02 00:05");
});

it("renders an unavailable card on load errors", () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  fireEvent.error(audio);
  expect(screen.getByRole("status")).toHaveTextContent("Audio unavailable");
});

it("renders an unavailable card for native audio without the media listener", async () => {
  const native = `buzz-media://localhost/${encodeURIComponent("https://relay.test/media/" + "b".repeat(64) + ".mp3")}`;
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={native}
    />,
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Audio unavailable",
  );
  expect(container.querySelector("audio")).toBeNull();
});

it("resets load failure and playback display when the source changes", async () => {
  const attachment = {
    url: "https://fixture.test/audio.mp3",
    kind: "audio",
    duration: 83,
  } as const;
  const { container, rerender } = render(
    <AudioAttachment attachment={attachment} source={source} />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  audio.currentTime = 42;
  fireEvent.timeUpdate(audio);
  expect(screen.getByRole("group")).toHaveTextContent("00:42 01:23");
  fireEvent.error(audio);
  expect(screen.getByRole("status")).toHaveTextContent("Audio unavailable");

  rerender(
    <AudioAttachment
      attachment={{ url: attachment.url, kind: attachment.kind }}
      source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Frecovered.mp3"
    />,
  );

  await waitFor(() =>
    expect(screen.queryByRole("status")).not.toBeInTheDocument(),
  );
  expect(container.querySelector("audio")).toBeInTheDocument();
  expect(screen.getByRole("group")).toHaveTextContent("00:00 —:—");
  expect(screen.getByRole("button", { name: "Play audio" })).toBeEnabled();
});

it("toggles playback from the play/pause button", async () => {
  const { container } = render(
    <AudioAttachment
      attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
      source={source}
    />,
  );
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("Missing audio element");
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name: "Play audio" });

  setPaused(audio, true);
  await user.click(button);
  expect(play).toHaveBeenCalledExactlyOnceWith();
  expect(play.mock.instances[0]).toBe(audio);

  setPaused(audio, false);
  await user.click(screen.getByRole("button", { name: "Pause audio" }));
  expect(pause).toHaveBeenCalledExactlyOnceWith();
  expect(pause.mock.instances[0]).toBe(audio);
});

it("does not pause a detached StrictMode audio after unmounting it mid-playback", () => {
  const first = (
    <AudioAttachment
      key="one"
      attachment={{ url: "https://fixture.test/one.mp3", kind: "audio" }}
      source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
    />
  );
  const second = (
    <AudioAttachment
      key="two"
      attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
      source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
    />
  );
  const { container, rerender } = render(
    <StrictMode>
      {first}
      {second}
    </StrictMode>,
  );
  const [detached] = Array.from(container.querySelectorAll("audio"));
  if (!detached) throw new Error("Missing audio element");
  fireEvent.play(detached);

  rerender(<StrictMode>{second}</StrictMode>);
  expect(detached).not.toBeInTheDocument();
  const remaining = container.querySelector("audio");
  if (!remaining) throw new Error("Missing remaining audio element");
  fireEvent.play(remaining);

  expect(pause).not.toHaveBeenCalled();
});

it("does not pause a failed StrictMode audio after it errors while playing", () => {
  const { container } = render(
    <StrictMode>
      <AudioAttachment
        attachment={{ url: "https://fixture.test/one.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
      />
      <AudioAttachment
        attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
      />
    </StrictMode>,
  );
  const [failed, next] = Array.from(container.querySelectorAll("audio"));
  if (!failed || !next) throw new Error("Missing audio elements");
  fireEvent.play(failed);
  fireEvent.error(failed);

  fireEvent.play(next);

  expect(pause).not.toHaveBeenCalled();
});

it("does not pause a recovered audio after unmounting it mid-playback", () => {
  const failedSource =
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ffailed.mp3";
  const recoveredSource =
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Frecovered.mp3";
  const nextSource =
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fnext.mp3";
  const attachment = {
    url: "https://fixture.test/audio.mp3",
    kind: "audio",
  } as const;
  const { container, rerender } = render(
    <StrictMode>
      <AudioAttachment
        key="recovering"
        attachment={attachment}
        source={failedSource}
      />
    </StrictMode>,
  );
  const failed = container.querySelector("audio");
  if (!failed) throw new Error("Missing failed audio element");
  fireEvent.error(failed);
  expect(screen.getByRole("status")).toHaveTextContent("Audio unavailable");

  rerender(
    <StrictMode>
      <AudioAttachment
        key="recovering"
        attachment={attachment}
        source={recoveredSource}
      />
    </StrictMode>,
  );
  const recovered = container.querySelector("audio");
  if (!recovered) throw new Error("Missing recovered audio element");
  fireEvent.play(recovered);

  rerender(
    <StrictMode>
      <AudioAttachment
        key="next"
        attachment={{ url: "https://fixture.test/next.mp3", kind: "audio" }}
        source={nextSource}
      />
    </StrictMode>,
  );
  expect(recovered).not.toBeInTheDocument();
  const next = container.querySelector("audio");
  if (!next) throw new Error("Missing next audio element");
  fireEvent.play(next);

  expect(pause).not.toHaveBeenCalled();
});

it("pauses another audio element when playback starts", () => {
  const { container } = render(
    <>
      <AudioAttachment
        attachment={{ url: "https://fixture.test/one.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fone.mp3"
      />
      <AudioAttachment
        attachment={{ url: "https://fixture.test/two.mp3", kind: "audio" }}
        source="/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.mp3"
      />
    </>,
  );
  const [first, second] = Array.from(container.querySelectorAll("audio"));
  if (!first || !second) throw new Error("Missing audio elements");
  fireEvent.play(first);
  fireEvent.play(second);
  expect(pause).toHaveBeenCalledExactlyOnceWith();
  expect(pause.mock.instances[0]).toBe(first);
  expect(play).not.toHaveBeenCalled();
});

it.each([false, true])(
  "pauses retained audio on withholding without autoplay on recovery (pending play: %s)",
  async (pending) => {
    const tree = (active: boolean) => (
      <StrictMode>
        <ConversationPresentation value={active}>
          <AudioAttachment
            attachment={{
              url: "https://fixture.test/audio.mp3",
              kind: "audio",
              duration: 83,
            }}
            source={source}
          />
        </ConversationPresentation>
      </StrictMode>
    );
    const view = render(tree(true));
    const audio = view.container.querySelector("audio");
    if (!audio) throw new Error("Missing audio");
    let resolvePlay: () => void = () => {};
    let rejectPlay: (error: Error) => void = () => {};
    if (pending) {
      const result = new Promise<void>((resolve, reject) => {
        resolvePlay = resolve;
        rejectPlay = reject;
      });
      play.mockImplementationOnce(function (this: HTMLMediaElement) {
        setPaused(this, false);
        this.dispatchEvent(new Event("play"));
        return result;
      });
    }
    try {
      fireEvent.click(screen.getByRole("button", { name: "Play audio" }));
      expect(play).toHaveBeenCalledTimes(1);
      expect(audio.paused).toBe(false);
      audio.currentTime = 24;
      fireEvent.timeUpdate(audio);
      view.rerender(tree(false));
      expect(pause).toHaveBeenCalledTimes(1);
      expect(audio.paused).toBe(true);
      expect(audio.currentTime).toBe(24);
      expect(view.container.querySelector("audio")).toBe(audio);
      expect(audio).toHaveAttribute("src", source);
      if (pending) {
        // Native pause interrupts an unresolved play request with AbortError.
        await act(async () =>
          rejectPlay(new DOMException("Playback interrupted", "AbortError")),
        );
      }
      setDuration(audio, 83);
      fireEvent.loadedMetadata(audio);
      expect(play).toHaveBeenCalledTimes(1);
      view.rerender(tree(true));
      expect(audio.paused).toBe(true);
      expect(audio.currentTime).toBe(24);
      expect(play).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Play audio" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Play audio" }));
      expect(audio.paused).toBe(false);
      expect(audio.currentTime).toBe(24);
    } finally {
      await act(async () => resolvePlay());
    }
  },
);

it("previews mouse hover time without seeking and clears on leave, touch, or source change", () => {
  const attachment = {
    url: "https://fixture.test/audio.mp3",
    kind: "audio" as const,
    duration: 80,
  };
  const { container, rerender } = render(
    <AudioAttachment attachment={attachment} source={source} />,
  );
  const audio = container.querySelector("audio");
  const timeline = screen.getByRole("slider").parentElement;
  if (!audio || !timeline) throw new Error("Missing audio controls");
  vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
    left: 100,
    width: 202,
  } as DOMRect);
  const move = (clientX: number, pointerType = "mouse") => {
    const event = new MouseEvent("pointermove", { bubbles: true, clientX });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    fireEvent(timeline, event);
  };
  const preview = () => container.querySelector("[data-seek-preview]");
  move(151);
  expect(preview()).toHaveTextContent("00:20");
  expect(audio.currentTime).toBe(0);
  move(251);
  expect(preview()).toHaveTextContent("01:00");
  move(500);
  expect(preview()).toHaveTextContent("01:20");
  move(0);
  expect(preview()).toHaveTextContent("00:00");
  fireEvent.pointerLeave(timeline);
  expect(preview()).toBeNull();
  move(151);
  move(151, "touch");
  expect(preview()).toBeNull();
  move(151);
  rerender(
    <AudioAttachment
      attachment={{ url: attachment.url, kind: "audio" }}
      source="/new-audio.mp3"
    />,
  );
  expect(preview()).toBeNull();
  move(151);
  expect(preview()).toBeNull();
});

it("shares playback ownership with voice-note plugin cards in both directions", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  try {
    const { container } = render(
      <>
        <AudioAttachment
          attachment={{ url: "https://fixture.test/audio.mp3", kind: "audio" }}
          source={source}
        />
        <VoiceNoteCard source="https://fixture.test/voice.wav" duration={5} />
      </>,
    );
    const [regular, voice] = container.querySelectorAll("audio");
    if (!regular || !voice) throw new Error("Missing audio players");
    await act(async () => {
      await regular.play();
    });
    expect(regular.paused).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play voice note" }));
    });
    expect(regular.paused).toBe(true);
    expect(voice.paused).toBe(false);
    await act(async () => {
      await regular.play();
    });
    expect(voice.paused).toBe(true);
    expect(regular.paused).toBe(false);
    cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});

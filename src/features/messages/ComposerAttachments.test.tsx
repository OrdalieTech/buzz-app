// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { ComposerAttachments } from "./ComposerAttachments";
import type { DraftAttachment } from "./attachment-draft";
import { AttachmentDownloadContext } from "./AttachmentDownloadContext";
import { apply as installVoiceNotes } from "../../bundled/voice-notes";
import type { AttachmentRenderer } from "../conversation/contracts";
import { AttachmentView } from "../conversation/AttachmentView";
import { ComposerAttachmentViewer } from "./ComposerAttachmentViewer";
import { UPLOAD_FAILURES } from "../relay/attachments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

it.each([false, true])(
  "never enables saving for an uploaded voice draft, including disabled=%s",
  async (disabled) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    let renderer!: AttachmentRenderer;
    installVoiceNotes({
      conversation: {
        registerTool: () => {},
        registerAttachment: (value: AttachmentRenderer) => {
          renderer = value;
        },
      },
    } as unknown as Parameters<NonNullable<typeof installVoiceNotes>>[0]);
    const entries = [
      { ...renderer, key: "voice/player", pluginId: "voice", revision: "1" },
    ];
    const registry = { snapshot: () => entries, subscribe: () => () => {} };
    const url = `https://relay.test/media/${"a".repeat(64)}.wav`;
    const source = `buzz-media://localhost/${encodeURIComponent(url)}`;
    const item: DraftAttachment = {
      id: "voice",
      file: new File(["sample"], "voice-note-sample.wav", {
        type: "audio/wav",
      }),
      status: "ready",
      voice: { duration: 1, waveform: [0.5] },
      uploaded: {
        url,
        name: "voice-note-sample.wav",
        type: "audio/wav",
        size: 6,
        sha256: "a".repeat(64),
      },
    };
    render(
      <AttachmentDownloadContext value={true}>
        <ComposerAttachments
          items={[item]}
          disabled={disabled}
          remove={() => {}}
          retry={() => {}}
          media={() => source}
          renderers={registry}
        />
      </AttachmentDownloadContext>,
    );
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: "Download voice note" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Play voice note" }),
    ).toBeTruthy();
    cleanup();
    render(
      <AttachmentDownloadContext value={true}>
        <ComposerAttachmentViewer
          items={[item]}
          selected={item.id}
          select={() => {}}
          media={() => source}
          renderers={registry}
          restoreFocus={{ current: null }}
          close={() => {}}
        />
      </AttachmentDownloadContext>,
    );
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: "Play voice note" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Download voice note" }),
    ).toBeNull();
    cleanup();
    render(
      <AttachmentDownloadContext value={true}>
        <AttachmentView
          registry={registry}
          attachment={{
            url,
            kind: "audio",
            voiceNote: true,
            name: "voice-note-sample.wav",
          }}
          source={source}
          fallback={<span>Fallback</span>}
        />
      </AttachmentDownloadContext>,
    );
    expect(
      screen.getByRole("button", { name: "Download voice note" }),
    ).toBeTruthy();
  },
);

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:attachment");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("shows progress during preparation and upload while the thumbnail stays clickable", () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:photo"),
      revokeObjectURL: vi.fn(),
    }),
  );
  const item: DraftAttachment = {
    id: "photo",
    file: new File(["png"], "photo.png", { type: "image/png" }),
    status: "queued",
  };
  const props = {
    items: [item],
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: () => undefined,
  };
  const root = render(<ComposerAttachments {...props} />);
  const remove = screen.getByRole("button", { name: "Remove photo.png" });
  expect(
    screen
      .getByRole("button", { name: "Preview photo.png" })
      .querySelector("img")
      ?.getAttribute("src"),
  ).toBe("blob:photo");
  // A queued sibling waits its turn while keeping a clickable local preview.
  expect(screen.getByRole("progressbar")).toBeTruthy();
  expect(remove.querySelector("[data-upload-cancel]")).not.toBeNull();

  for (const status of ["preparing", "uploading"] as const) {
    root.rerender(
      <ComposerAttachments {...props} items={[{ ...item, status }]} />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Uploading photo.png",
    );
    expect(remove.querySelector("[data-upload-cancel]")).not.toBeNull();
  }
  for (const status of ["ready", "error"] as const) {
    root.rerender(
      <ComposerAttachments {...props} items={[{ ...item, status }]} />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: `${status === "error" ? "Retry" : "Remove"} photo.png`,
      }),
    ).toBeTruthy();
  }
});

it("replaces a failed original-video preview with authenticated converted media", async () => {
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:original"),
      revokeObjectURL: revoke,
    }),
  );
  const item: DraftAttachment = {
    id: "one",
    file: new File(["unsupported"], "clip.mov", { type: "video/quicktime" }),
    status: "uploading",
  };
  const props = {
    items: [item],
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: (url: string) => `/api/media?url=${encodeURIComponent(url)}`,
  };
  const root = render(<ComposerAttachments {...props} />);
  const original = root.container.querySelector("video");
  assert.exists(original);
  // WebKitGTK suspends muted videos outside the viewport; see the component.
  expect(original.muted).toBe(false);
  fireEvent.error(original);
  expect(screen.getByText("Preview unavailable")).toBeTruthy();
  const uploaded = {
    name: "clip.mp4",
    type: "video/mp4",
    size: 20,
    sha256: "a".repeat(64),
    url: "https://relay.test/media/clip.mp4",
  };
  await act(async () =>
    root.rerender(
      <ComposerAttachments
        {...props}
        items={[{ ...item, status: "ready", uploaded }]}
      />,
    ),
  );
  expect(screen.queryByText("Preview unavailable")).toBeNull();
  const converted = root.container.querySelector("video");
  assert.exists(converted);
  expect(converted.getAttribute("src")).toBe(props.media(uploaded.url));
  expect(converted).not.toBe(original);
  expect(revoke).toHaveBeenCalledWith("blob:original");
  fireEvent.click(screen.getByRole("button", { name: "Preview clip.mov" }));
  expect(
    screen.getByRole("dialog").querySelector("video")?.getAttribute("src"),
  ).toBe(props.media(uploaded.url));
});

it.each(["report.pdf", "not-an-image.png", "not-a-video.mp4"])(
  "uses canonical generic type for %s instead of rendering image or video",
  (name) => {
    const create = vi.fn(() => "blob:original");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
    );
    const item: DraftAttachment = {
      id: "document",
      file: new File(["document"], name, { type: "video/mp4" }),
      status: "ready",
      uploaded: {
        name,
        type: "application/octet-stream",
        size: 8,
        sha256: "b".repeat(64),
        url: "https://relay.test/media/document.bin",
      },
    };
    const root = render(
      <ComposerAttachments
        items={[item]}
        disabled={false}
        remove={vi.fn()}
        retry={vi.fn()}
        media={() => "/api/relay/media?url=document"}
      />,
    );
    expect(screen.getByText(name)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Preview ${name}` }),
    ).toBeTruthy();
    expect(root.container.querySelector("video, img")).toBeNull();
    expect(screen.queryByText("Preview unavailable")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  },
);

it("does not fall back to an untrusted original when canonical media cannot be resolved", () => {
  const create = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
  );
  const item: DraftAttachment = {
    id: "one",
    file: new File(["source"], "clip.mov", { type: "video/quicktime" }),
    status: "ready",
    uploaded: {
      name: "clip.mp4",
      type: "video/mp4",
      size: 20,
      sha256: "a".repeat(64),
      url: "https://relay.test/media/clip.mp4",
    },
  };
  const root = render(
    <ComposerAttachments
      items={[item]}
      disabled={false}
      remove={vi.fn()}
      retry={vi.fn()}
      media={() => undefined}
    />,
  );
  expect(root.container.querySelector("video, img")).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

it.each([
  ["report.pdf", "application/pdf"],
  ["photo.png", "image/png"],
  ["clip.mp4", "video/mp4"],
])(
  "explains a failed %s and preserves retry and removal",
  async (name, type) => {
    const retry = vi.fn();
    const remove = vi.fn();
    render(
      <ComposerAttachments
        items={[
          {
            id: "failed-file",
            file: new File(["document"], name, { type }),
            status: "error",
            error: "The relay rejected this file.",
          },
        ]}
        disabled={false}
        retry={retry}
        remove={remove}
        media={() => undefined}
      />,
    );
    expect(
      screen.getByText("The relay rejected this file.", {
        selector: "p",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      `${name}: The relay rejected this file.`,
    );
    const retryButton = screen.getByRole("button", { name: `Retry ${name}` });
    const removeButton = screen.getByRole("button", { name: `Remove ${name}` });
    expect(retryButton.textContent).toBe("Retry");
    expect(removeButton.textContent).toBe("Remove");
    act(() => retryButton.focus());
    expect(retryButton.getAttribute("title")).toBeNull();
    fireEvent.click(retryButton);
    expect(retry).toHaveBeenCalledWith("failed-file");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Preview ${name}` }),
    );
    fireEvent.keyDown(retryButton, {
      key: "Delete",
    });
    fireEvent.keyDown(retryButton, { key: "Backspace" });
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(removeButton);
    expect(remove).toHaveBeenCalledExactlyOnceWith("failed-file");
    expect(retry).toHaveBeenCalledOnce();
  },
);

it.each([
  UPLOAD_FAILURES.duration,
  UPLOAD_FAILURES.denied,
  "Upload paused. Retry to continue.",
])("shows the specific upload guidance: %s", (error) => {
  render(
    <ComposerAttachments
      items={[
        {
          id: "clip",
          file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
          status: "error",
          error,
        },
      ]}
      disabled={false}
      remove={() => {}}
      retry={() => {}}
      media={() => undefined}
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe(`clip.mp4: ${error}`);
  expect(screen.getByText(error, { selector: "p" })).toBe(alert);
  expect(alert.classList.contains("sr-only")).toBe(false);
  expect(
    screen.queryByText("Upload failed. Retry or remove it to send."),
  ).toBeNull();
});

it("explains errors without service details and disables both recovery actions", () => {
  const item: DraftAttachment = {
    id: "photo",
    file: new File(["image"], "photo.png", { type: "image/png" }),
    status: "error",
  };
  const props = { remove: vi.fn(), retry: vi.fn(), media: () => undefined };
  const root = render(
    <ComposerAttachments {...props} items={[item]} disabled />,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "photo.png: Upload failed. Retry or remove it to send.",
  );
  for (const action of ["Retry", "Remove"]) {
    const button = screen.getByRole("button", { name: `${action} photo.png` });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Delete" });
  }
  expect(props.retry).not.toHaveBeenCalled();
  expect(props.remove).not.toHaveBeenCalled();
  root.rerender(
    <ComposerAttachments
      {...props}
      items={[{ ...item, status: "uploading" }]}
      disabled={false}
    />,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("progressbar")).toBeTruthy();
  root.rerender(
    <ComposerAttachments {...props} items={[item]} disabled={false} />,
  );
  expect(screen.getByRole("alert")).toBeTruthy();
  root.rerender(
    <ComposerAttachments
      {...props}
      items={[{ ...item, status: "ready" }]}
      disabled={false}
    />,
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps removal available during upload", () => {
  const remove = vi.fn();
  render(
    <ComposerAttachments
      items={[
        {
          id: "pending",
          file: new File(["data"], "pending.pdf"),
          status: "uploading",
        },
      ]}
      disabled={false}
      remove={remove}
      retry={vi.fn()}
      media={() => undefined}
    />,
  );
  const control = screen.getByRole("button", { name: "Remove pending.pdf" });
  expect(screen.getByRole("progressbar")).toBeTruthy();
  fireEvent.click(control);
  expect(remove).toHaveBeenCalledWith("pending");
});

it("removes immediately without playing a poof sound", () => {
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  const item: DraftAttachment = {
    id: "one",
    file: new File(["text"], "notes.txt"),
    status: "queued",
  };
  const remove = vi.fn();
  const props = {
    disabled: false,
    remove,
    retry: vi.fn(),
    media: () => undefined,
  };
  const view = render(<ComposerAttachments {...props} items={[item]} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
  expect(remove).toHaveBeenCalledWith("one");
  view.rerender(<ComposerAttachments {...props} items={[]} />);
  expect(audio).not.toHaveBeenCalled();
  expect(document.querySelector("[data-attachment-poof]")).toBeNull();
});

it("shows a returning draft at once and animates only attachments picked later", async () => {
  const props = {
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: () => undefined,
  };
  const item = (name: string): DraftAttachment => ({
    id: name,
    file: new File(["text"], name),
    status: "queued",
  });
  const row = (name: string) =>
    screen.getByText(name).closest("li") as HTMLElement;
  const view = render(
    <ComposerAttachments {...props} items={[item("restored.txt")]} />,
  );
  // The composer remounted with this draft (switching back to a channel).
  expect(row("restored.txt").style.opacity).toBe("1");
  view.rerender(<ComposerAttachments {...props} items={[]} />);
  view.rerender(
    <ComposerAttachments {...props} items={[item("picked.txt")]} />,
  );
  expect(row("picked.txt").style.opacity).toBe("0");
  await waitFor(() => expect(row("picked.txt").style.opacity).toBe("1"));
});

it("dismisses draft preview while retaining the original file and preview URL", async () => {
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi
        .fn()
        .mockReturnValueOnce("blob:thumbnail")
        .mockReturnValue("blob:viewer"),
      revokeObjectURL: revoke,
    }),
  );
  const items: DraftAttachment[] = [
    {
      id: "draft",
      file: new File(["image"], "draft.png", { type: "image/png" }),
      status: "uploading",
    },
  ];
  const remove = vi.fn(),
    retry = vi.fn();
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <div hidden={!active} inert={!active}>
        <ComposerAttachments
          items={items}
          disabled={false}
          remove={remove}
          retry={retry}
          media={(url) => url}
        />
      </div>
    </ConversationPresentation>
  );
  const view = render(tree(true));
  const thumbnail = view.container.querySelector("img");
  const trigger = screen.getByRole("button", { name: "Preview draft.png" });
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    ),
  );
  const focus = vi.spyOn(trigger, "focus");
  view.rerender(tree(false));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  view.rerender(tree(true));
  await act(() => Promise.resolve());
  expect(focus).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(view.container.querySelector("img")).toBe(thumbnail);
  expect(revoke).toHaveBeenCalledWith("blob:viewer");
  expect(revoke).not.toHaveBeenCalledWith("blob:thumbnail");
  expect(remove).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
});

it("navigates local image and video previews while uploading without sent-message controls", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
      revokeObjectURL: vi.fn(),
    }),
  );
  const items: DraftAttachment[] = [
    {
      id: "image",
      file: new File(["image"], "photo.png", { type: "image/png" }),
      status: "uploading",
      transfer: { sent: 2, total: 8 },
    },
    {
      id: "video",
      file: new File(["video"], "clip.mp4"),
      status: "preparing",
    },
  ];
  const remove = vi.fn(),
    retry = vi.fn();
  const props = {
    items,
    disabled: false,
    remove,
    retry,
    media: (url: string) => `/canonical?url=${url}`,
  };
  const view = render(<ComposerAttachments {...props} />);
  expect(
    screen
      .getByRole("progressbar", { name: "Uploading photo.png" })
      .getAttribute("aria-valuenow"),
  ).toBe("25");
  const trigger = screen.getByRole("button", { name: "Preview clip.mp4" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(
    screen.getByRole("dialog").querySelector("video")?.getAttribute("src"),
  ).toBe("blob:clip.mp4");
  expect(screen.getByRole("button", { name: /Playback speed/ })).toBeTruthy();
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: " " });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /comments/i })).toBeNull();
  expect(screen.queryByLabelText("Media comments")).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  expect(
    screen.getByRole("dialog").querySelector("img")?.getAttribute("src"),
  ).toBe("blob:photo.png");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  assert.exists(items[0]);
  assert.exists(items[1]);
  view.rerender(
    <ComposerAttachments
      {...props}
      items={[
        items[0],
        {
          ...items[1],
          status: "ready",
          uploaded: {
            url: "https://relay.test/clip.mp4",
            name: "clip.mp4",
            type: "video/mp4",
            size: 8,
            sha256: "a".repeat(64),
          },
        },
      ]}
    />,
  );
  expect(
    screen.getByRole("dialog").querySelector("video")?.getAttribute("src"),
  ).toBe("blob:clip.mp4");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Preview clip.mp4" }),
    ),
  );
  expect(
    screen.getByRole("button", { name: "Preview photo.png" }),
  ).toBeTruthy();
  expect(remove).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
});

it("shows unavailable playback when the native media listener cannot start", async () => {
  const url = `https://relay.test/media/${"a".repeat(64)}.mp4`;
  render(
    <ComposerAttachments
      items={[
        {
          id: "native-video",
          file: new File([], "clip.mp4", { type: "video/mp4" }),
          status: "ready",
          uploaded: {
            url,
            name: "clip.mp4",
            type: "video/mp4",
            size: 8,
            sha256: "a".repeat(64),
          },
        },
      ]}
      disabled={false}
      remove={vi.fn()}
      retry={vi.fn()}
      media={() => `buzz-media://localhost/${encodeURIComponent(url)}`}
    />,
  );
  await screen.findByText("Preview unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Preview clip.mp4" }));
  await waitFor(() =>
    expect(screen.getByRole("dialog").textContent).toContain(
      "Preview unavailable",
    ),
  );
  expect(screen.getByRole("dialog").querySelector("video")).toBeNull();
});

it("returns focus to the selected generic attachment after viewer navigation", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:photo"),
      revokeObjectURL: vi.fn(),
    }),
  );
  render(
    <ComposerAttachments
      items={[
        {
          id: "image",
          file: new File(["png"], "photo.png", { type: "image/png" }),
          status: "uploading",
        },
        {
          id: "pdf",
          file: new File(["pdf"], "report.pdf", { type: "application/pdf" }),
          status: "queued",
        },
      ]}
      disabled={false}
      remove={vi.fn()}
      retry={vi.fn()}
      media={() => undefined}
    />,
  );
  const image = screen.getByRole("button", { name: "Preview photo.png" });
  image.focus();
  fireEvent.click(image);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(screen.getByRole("dialog").textContent).toContain(
    "No preview available for this file type.",
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Preview report.pdf" }),
    ),
  );
});

it("keeps the playing video and its owned blob alive when its upload completes", async () => {
  let sequence = 0;
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:owned-${++sequence}`),
      revokeObjectURL: revoke,
    }),
  );
  const item: DraftAttachment = {
    id: "video",
    file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
    status: "uploading",
  };
  const props = {
    items: [item],
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: (url: string) => `/canonical?url=${url}`,
  };
  const view = render(<ComposerAttachments {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview clip.mp4" }));
  const video = screen.getByRole("dialog").querySelector("video");
  assert.exists(video);
  video.currentTime = 12;
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => false,
  });
  fireEvent.play(video);
  const source = video.getAttribute("src");
  vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
  const ready: DraftAttachment = {
    ...item,
    status: "ready",
    uploaded: {
      url: "https://relay.test/clip.mp4",
      name: "clip.mp4",
      type: "video/mp4",
      size: 8,
      sha256: "a".repeat(64),
    },
  };
  view.rerender(<ComposerAttachments {...props} items={[ready]} />);
  expect(screen.getByRole("dialog").querySelector("video")).toBe(video);
  expect(video.currentTime).toBe(12);
  expect(video.paused).toBe(false);
  expect(video.getAttribute("src")).toBe(source);
  expect(revoke).not.toHaveBeenCalledWith(source);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(revoke).toHaveBeenCalledWith(source);
  fireEvent.click(screen.getByRole("button", { name: "Preview clip.mp4" }));
  expect(
    screen.getByRole("dialog").querySelector("video")?.getAttribute("src"),
  ).toBe(props.media("https://relay.test/clip.mp4"));
});

it("keeps the open image when upload replaces PNG with canonical WebP", () => {
  let sequence = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:image-${++sequence}`),
      revokeObjectURL: vi.fn(),
    }),
  );
  const item: DraftAttachment = {
    id: "image",
    file: new File(["png"], "photo.png", { type: "image/png" }),
    status: "uploading",
  };
  const props = {
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: (url: string) => url,
  };
  const view = render(<ComposerAttachments {...props} items={[item]} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview photo.png" }));
  const image = screen.getByRole("dialog").querySelector("img");
  assert.exists(image);
  const source = image.getAttribute("src");
  view.rerender(
    <ComposerAttachments
      {...props}
      items={[
        {
          ...item,
          status: "ready",
          uploaded: {
            url: "https://relay.test/photo.webp",
            name: "photo.webp",
            type: "image/webp",
            size: 8,
            sha256: "a".repeat(64),
          },
        },
      ]}
    />,
  );
  expect(screen.getByRole("dialog").querySelector("img")).toBe(image);
  expect(image.getAttribute("src")).toBe(source);
});

it("compacts media beside non-media chips and restores media-only previews after removal", () => {
  const image: DraftAttachment = {
    id: "image",
    file: new File([], "photo.png", { type: "image/png" }),
    status: "ready",
    uploaded: {
      url: "https://fixture.test/photo",
      name: "photo.png",
      type: "image/png",
      size: 1,
      sha256: "0".repeat(64),
    },
  };
  const file: DraftAttachment = {
    id: "file",
    file: new File([], "notes.txt", { type: "text/plain" }),
    status: "ready",
  };
  const props = {
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: () => undefined,
  };
  const view = render(<ComposerAttachments {...props} items={[image, file]} />);
  expect(screen.getByRole("list").hasAttribute("data-compact-media")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
  expect(props.remove).toHaveBeenCalledWith("file");
  view.rerender(<ComposerAttachments {...props} items={[image]} />);
  expect(screen.getByRole("list").hasAttribute("data-compact-media")).toBe(
    false,
  );
});

it("keeps the local thumbnail until the uploaded image has loaded", () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:local"),
      revokeObjectURL: vi.fn(),
    }),
  );
  const item: DraftAttachment = {
    id: "image",
    file: new File(["png"], "photo.png", { type: "image/png" }),
    status: "uploading",
  };
  const props = {
    disabled: false,
    remove: vi.fn(),
    retry: vi.fn(),
    media: (url: string) => `/media?url=${url}`,
  };
  const view = render(<ComposerAttachments {...props} items={[item]} />);
  const sources = () =>
    Array.from(view.container.querySelectorAll("img"), (image) =>
      image.getAttribute("src"),
    );
  fireEvent.load(view.container.querySelector("img") as HTMLImageElement);
  expect(sources()).toEqual(["blob:local"]);
  view.rerender(
    <ComposerAttachments
      {...props}
      items={[
        {
          ...item,
          status: "ready",
          uploaded: {
            url: "https://relay.test/photo.webp",
            name: "photo.webp",
            type: "image/webp",
            size: 8,
            sha256: "a".repeat(64),
          },
        },
      ]}
    />,
  );
  const canonical = "/media?url=https://relay.test/photo.webp";
  expect(sources()).toEqual(["blob:local", canonical]);
  const incoming = view.container.querySelectorAll("img")[1];
  assert.exists(incoming);
  fireEvent.load(incoming);
  expect(sources()).toEqual([canonical]);
  expect(view.container.querySelector("img")).toBe(incoming);
});

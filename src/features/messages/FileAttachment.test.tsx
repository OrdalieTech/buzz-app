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
import userEvent from "@testing-library/user-event";
import {
  downloadNativeMedia,
  openSavedDownload,
  savedDownloadStatus,
  subscribeSavedDownloads,
} from "./native-download";
import { FileAttachment, formatFileSize } from "./FileAttachment";

vi.mock("./native-download", () => ({
  downloadNativeMedia: vi.fn(),
  openSavedDownload: vi.fn(),
  savedDownloadStatus: vi.fn(),
  subscribeSavedDownloads: vi.fn(),
}));

const proxySource = "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ffile";

beforeEach(() => {
  vi.mocked(savedDownloadStatus).mockResolvedValue(false);
  vi.mocked(subscribeSavedDownloads).mockReturnValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it.each([
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1 KB"],
  [1536, "2 KB"],
  [1024 * 1024, "1 MB"],
  [1024 * 1024 * 1024, "1 GB"],
])("formats file sizes at unit boundaries", (size, label) => {
  expect(formatFileSize(size)).toBe(label);
});

it("falls back to a mime-derived file label", () => {
  render(
    <FileAttachment
      attachment={{
        url: "https://fixture.test/file",
        kind: "file",
        mime: "application/pdf",
      }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Download PDF file" }),
  ).toHaveAttribute("href", proxySource);
  expect(screen.getByText("PDF file")).toBeInTheDocument();
  expect(screen.getByText("Download file")).toBeInTheDocument();
});

it("falls back to a generic file label", () => {
  render(
    <FileAttachment
      attachment={{ url: "https://fixture.test/file", kind: "file" }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Download File" }),
  ).toBeInTheDocument();
});

it("keeps nameless downloads on the media href", () => {
  render(
    <FileAttachment
      attachment={{ url: "https://fixture.test/file", kind: "file" }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("link", { name: "Download File" })).toHaveAttribute(
    "href",
    proxySource,
  );
  expect(screen.getByRole("link", { name: "Download File" })).toHaveAttribute(
    "download",
    "",
  );
});

it("renders long names as the title while keeping full download semantics", () => {
  const name = `${"Very long report name ".repeat(12)}.pdf`;
  render(
    <FileAttachment
      attachment={{
        url: "https://fixture.test/file",
        kind: "file",
        name,
        size: 1536,
      }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  const link = screen.getByRole("link", { name: `Download ${name}` });
  expect(link).toHaveAttribute("download", name);
  expect(link).toHaveAttribute("title", name);
  expect(screen.getByText("2 KB")).toBeInTheDocument();
});

it("opens external https sources through the opener pattern without download affordance", () => {
  const source = "https://files.example/report.pdf";
  const open = vi.fn(() => true);
  render(
    <FileAttachment
      attachment={{
        url: source,
        kind: "file",
        name: "report.pdf",
      }}
      source={source}
      onOpenLink={open}
    />,
  );
  const link = screen.getByRole("link", { name: "Open report.pdf" });
  expect(link).toHaveAttribute("href", source);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(link).not.toHaveAttribute("download");
  expect(screen.getByText("Open file")).toBeInTheDocument();
  expect(fireEvent.click(link)).toBe(false);
  expect(open).toHaveBeenCalledWith(source);
});

it("renders unopenable file sources as unavailable", () => {
  render(
    <FileAttachment
      attachment={{
        url: "https://fixture.test/file",
        kind: "file",
        name: "file.pdf",
      }}
      source="blob:https://fixture.test/file"
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("File unavailable");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it.each(["application/octet-stream"])(
  "does not derive noisy labels from %s",
  (mime) => {
    render(
      <FileAttachment
        attachment={{ url: "https://fixture.test/file", kind: "file", mime }}
        source={proxySource}
        onOpenLink={() => false}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Download File" }),
    ).toBeInTheDocument();
    expect(screen.getByText("File")).toBeInTheDocument();
  },
);

const nativeSource = `buzz-media://localhost/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.pdf`)}`;

it("keeps preview and native download as separate keyboard actions", async () => {
  vi.mocked(downloadNativeMedia).mockClear().mockResolvedValue(undefined);
  const preview = vi.fn();
  render(
    <FileAttachment
      attachment={{
        url: "https://relay.test/file",
        kind: "file",
        name: "report.pdf",
        size: 132,
      }}
      source={nativeSource}
      onOpenLink={() => false}
      onPreview={preview}
      typeLabel="PDF"
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Preview report.pdf" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(preview).toHaveBeenCalledOnce();
  expect(downloadNativeMedia).not.toHaveBeenCalled();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Download report.pdf" }),
  ).toHaveFocus();
  expect(screen.getByText("PDF · 132 B")).toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(downloadNativeMedia).toHaveBeenCalledWith(nativeSource, "report.pdf");
  expect(preview).toHaveBeenCalledOnce();
  expect(await screen.findByText("Saved to Downloads")).toBeInTheDocument();
});

it("downloads authenticated native documents through the host without navigating", async () => {
  vi.mocked(downloadNativeMedia).mockResolvedValue(undefined);
  const open = vi.fn(() => false);
  render(
    <FileAttachment
      attachment={{
        url: "https://relay.test/media/file",
        kind: "file",
        name: "report.pdf",
      }}
      source={nativeSource}
      onOpenLink={open}
    />,
  );
  const link = screen.getByRole("button", { name: "Download report.pdf" });
  expect(link).not.toHaveAttribute("href");
  expect(screen.getByText("Download file")).toBeInTheDocument();
  // The host has said there is no saved copy.
  await act(async () => {});
  fireEvent.click(link);
  expect(open).not.toHaveBeenCalled();
  expect(downloadNativeMedia).toHaveBeenCalledWith(nativeSource, "report.pdf");
  await screen.findByText("Downloaded");
});

it.each([
  `buzz-media://evil.test/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}`)}`,
  `buzz-media://localhost/${encodeURIComponent("https://relay.test/query")}`,
])("does not offer a download for native lookalike %s", (source) => {
  render(
    <FileAttachment
      attachment={{ url: "https://relay.test/file", kind: "file" }}
      source={source}
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("File unavailable");
  expect(screen.queryByRole("link")).toBeNull();
});

it("reports native download failures without navigating", async () => {
  vi.mocked(downloadNativeMedia).mockRejectedValueOnce(
    new Error("unavailable"),
  );
  render(
    <FileAttachment
      attachment={{
        url: "https://relay.test/file",
        kind: "file",
        name: "report.pdf",
      }}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t download report.pdf. Try again.",
    ),
  );
});

function heldDownload() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function heldStatus() {
  let answer!: (saved: boolean) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => {
    answer = yes;
    fail = no;
  });
  return { promise, answer, fail };
}

const file = {
  url: "https://relay.test/file",
  kind: "file" as const,
  name: "report.pdf",
  size: 1024,
};

it("preserves focus and blocks repeat saves while pending, then offers Open", async () => {
  const download = heldDownload();
  vi.mocked(downloadNativeMedia).mockReturnValueOnce(download.promise);
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  // The host has said there is no saved copy.
  await act(async () => {});
  button.focus();
  fireEvent.click(button);
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  expect(button).toHaveTextContent("Downloading…");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Downloading report.pdf",
  );
  fireEvent.click(button);
  expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
  await act(async () => download.resolve());
  expect(button).toHaveTextContent("1 KB · Downloaded");
  expect(button).toHaveAttribute("aria-busy", "false");
  expect(button).toHaveAccessibleName("Open report.pdf");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Saved report.pdf to Downloads",
  );
  // The saved copy opens; it is not downloaded again.
  vi.mocked(openSavedDownload).mockResolvedValueOnce("opened");
  fireEvent.click(button);
  await act(async () => {});
  expect(openSavedDownload).toHaveBeenCalledWith(
    nativeSource,
    "report.pdf",
    false,
  );
  expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
  expect(button).toHaveTextContent("1 KB · Downloaded");
});

it("offers Open when the host already has the saved copy", async () => {
  vi.mocked(savedDownloadStatus).mockResolvedValue(true);
  vi.mocked(openSavedDownload).mockResolvedValue("opened");
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Open report.pdf",
  });
  expect(savedDownloadStatus).toHaveBeenCalledWith(nativeSource, "report.pdf");
  expect(button).toHaveTextContent("1 KB · Downloaded");
  // A copy found on mount is not announced.
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  fireEvent.click(button);
  await act(async () => {});
  expect(openSavedDownload).toHaveBeenCalledWith(
    nativeSource,
    "report.pdf",
    false,
  );
  expect(downloadNativeMedia).not.toHaveBeenCalled();
});

it("returns to Download, and says why, when the saved file moved or changed", async () => {
  vi.mocked(savedDownloadStatus).mockResolvedValue(true);
  vi.mocked(openSavedDownload).mockResolvedValueOnce("moved");
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Open report.pdf" }),
  );
  const button = await screen.findByRole("button", {
    name: "Download report.pdf",
  });
  expect(button).toHaveTextContent("Moved or changed · Download again");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "report.pdf was moved or changed. Download it again.",
  );
  vi.mocked(downloadNativeMedia).mockResolvedValueOnce(undefined);
  fireEvent.click(button);
  await act(async () => {});
  expect(downloadNativeMedia).toHaveBeenCalledWith(nativeSource, "report.pdf");
  expect(button).toHaveAccessibleName("Open report.pdf");
});

it("keeps Open and reports when the saved file could not be opened", async () => {
  vi.mocked(savedDownloadStatus).mockResolvedValue(true);
  vi.mocked(openSavedDownload)
    .mockRejectedValueOnce("Could not open the saved file")
    .mockResolvedValueOnce("opened");
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Open report.pdf",
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t open report.pdf. Try again.",
    ),
  );
  expect(button).toHaveTextContent("Couldn’t open · Try again");
  expect(button).toHaveAccessibleName("Open report.pdf");
  fireEvent.click(button);
  await act(async () => {});
  expect(button).toHaveTextContent("1 KB · Downloaded");
  expect(downloadNativeMedia).not.toHaveBeenCalled();
});

it("shows the saved copy in its folder or downloads it again from the context menu", async () => {
  vi.mocked(savedDownloadStatus).mockResolvedValue(true);
  vi.mocked(openSavedDownload).mockResolvedValue("opened");
  vi.mocked(downloadNativeMedia).mockResolvedValue(undefined);
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Open report.pdf",
  });
  fireEvent.contextMenu(button, { clientX: 20, clientY: 20 });
  // jsdom reports no Apple platform, so the folder wording appears.
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Show in folder" }),
  );
  await waitFor(() =>
    expect(openSavedDownload).toHaveBeenCalledWith(
      nativeSource,
      "report.pdf",
      true,
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  fireEvent.contextMenu(button, { clientX: 20, clientY: 20 });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Download again" }),
  );
  await waitFor(() =>
    expect(downloadNativeMedia).toHaveBeenCalledWith(
      nativeSource,
      "report.pdf",
    ),
  );
  expect(button).toHaveAccessibleName("Open report.pdf");
});

it("has no context menu until a saved copy exists", async () => {
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  await act(async () => {});
  fireEvent.contextMenu(button, { clientX: 20, clientY: 20 });
  await act(async () => {});
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("switches to Open when another card or window saves the file", async () => {
  let changed = () => {};
  vi.mocked(subscribeSavedDownloads).mockImplementation((callback) => {
    changed = callback;
    return () => {};
  });
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  await act(async () => {});
  expect(savedDownloadStatus).toHaveBeenCalledTimes(1);
  vi.mocked(savedDownloadStatus).mockResolvedValue(true);
  await act(async () => changed());
  expect(savedDownloadStatus).toHaveBeenCalledTimes(2);
  expect(button).toHaveAccessibleName("Open report.pdf");
  // The ledger dropping the file takes Open away again.
  vi.mocked(savedDownloadStatus).mockResolvedValue(false);
  await act(async () => changed());
  expect(button).toHaveAccessibleName("Download report.pdf");
});

it("ignores a status that arrives after the card unmounts or after a click", async () => {
  let answer!: (saved: boolean) => void;
  vi.mocked(savedDownloadStatus).mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const { unmount } = render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const stop = vi.fn();
  vi.mocked(subscribeSavedDownloads).mockReturnValue(stop);
  unmount();
  await act(async () => answer(true));
  expect(screen.queryByRole("button")).not.toBeInTheDocument();

  // A stale "not saved" answer must not undo a download that finished first.
  let late!: (saved: boolean) => void;
  vi.mocked(savedDownloadStatus).mockReturnValueOnce(
    new Promise((resolve) => {
      late = resolve;
    }),
  );
  vi.mocked(downloadNativeMedia).mockResolvedValueOnce(undefined);
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  fireEvent.click(button);
  await act(async () => {});
  expect(button).toHaveAccessibleName("Open report.pdf");
  await act(async () => late(false));
  expect(button).toHaveAccessibleName("Open report.pdf");
});

it.each([
  [true, "opens the saved copy"],
  [false, "downloads"],
])(
  "asks the host for a click made before its first answer (saved: %s) and %s",
  async (saved) => {
    const first = heldStatus();
    const asked = heldStatus();
    vi.mocked(savedDownloadStatus)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(asked.promise);
    vi.mocked(openSavedDownload).mockResolvedValue("opened");
    vi.mocked(downloadNativeMedia).mockResolvedValue(undefined);
    render(
      <FileAttachment
        attachment={file}
        source={nativeSource}
        onOpenLink={() => false}
      />,
    );
    const button = screen.getByRole("button", { name: "Download report.pdf" });
    // The card's own check on mount is silent and leaves the card usable.
    expect(button).toHaveTextContent("1 KB");
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    button.focus();
    fireEvent.click(button);
    expect(savedDownloadStatus).toHaveBeenCalledTimes(2);
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleName("Download report.pdf");
    expect(button).toHaveTextContent("Checking…");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for a saved copy of report.pdf",
    );
    // A repeat click neither asks again nor acts.
    fireEvent.click(button);
    expect(savedDownloadStatus).toHaveBeenCalledTimes(2);
    expect(downloadNativeMedia).not.toHaveBeenCalled();
    expect(openSavedDownload).not.toHaveBeenCalled();

    await act(async () => asked.answer(saved));
    await waitFor(() => expect(button).toHaveAccessibleName("Open report.pdf"));
    expect(openSavedDownload).toHaveBeenCalledTimes(saved ? 1 : 0);
    expect(downloadNativeMedia).toHaveBeenCalledTimes(saved ? 0 : 1);
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button).toHaveTextContent("1 KB · Downloaded");
    if (saved) expect(screen.getByRole("status")).toBeEmptyDOMElement();
    else
      expect(screen.getByRole("status")).toHaveTextContent(
        "Saved report.pdf to Downloads",
      );
    // The first answer is out of date by now, whatever it says.
    await act(async () => first.answer(false));
    expect(button).toHaveAccessibleName("Open report.pdf");
  },
);

it("offers Download, without asking again, when its first lookup fails", async () => {
  const first = heldStatus();
  vi.mocked(savedDownloadStatus).mockReturnValueOnce(first.promise);
  vi.mocked(downloadNativeMedia).mockResolvedValue(undefined);
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  await act(async () => first.fail(new Error("unavailable")));
  fireEvent.click(button);
  expect(savedDownloadStatus).toHaveBeenCalledTimes(1);
  expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
  expect(button).toHaveTextContent("Downloading…");
  await waitFor(() => expect(button).toHaveAccessibleName("Open report.pdf"));
});

it("downloads when the host never says whether a saved copy exists", async () => {
  vi.useFakeTimers();
  vi.mocked(savedDownloadStatus).mockReturnValue(new Promise(() => {}));
  vi.mocked(downloadNativeMedia).mockResolvedValue(undefined);
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  fireEvent.click(button);
  expect(button).toHaveTextContent("Checking…");
  await act(async () => vi.advanceTimersByTimeAsync(4999));
  expect(button).toHaveTextContent("Checking…");
  expect(downloadNativeMedia).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
  expect(openSavedDownload).not.toHaveBeenCalled();
  expect(button).toHaveAccessibleName("Open report.pdf");
  expect(button).toHaveAttribute("aria-busy", "false");
});

it("keeps the newest status when an older one answers after it", async () => {
  let changed = () => {};
  vi.mocked(subscribeSavedDownloads).mockImplementation((callback) => {
    changed = callback;
    return () => {};
  });
  const older = heldStatus();
  const newer = heldStatus();
  vi.mocked(savedDownloadStatus)
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);
  vi.mocked(openSavedDownload).mockResolvedValue("opened");
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  // Another card saved the file before this card's mount lookup answered.
  act(() => changed());
  expect(savedDownloadStatus).toHaveBeenCalledTimes(2);
  await act(async () => newer.answer(true));
  expect(button).toHaveAccessibleName("Open report.pdf");
  await act(async () => older.answer(false));
  expect(button).toHaveAccessibleName("Open report.pdf");
  fireEvent.click(button);
  await act(async () => {});
  expect(openSavedDownload).toHaveBeenCalledTimes(1);
  expect(downloadNativeMedia).not.toHaveBeenCalled();
});

it("stays pending through a status refresh, and keeps the saved copy's menu when Download again fails", async () => {
  let changed = () => {};
  vi.mocked(subscribeSavedDownloads).mockImplementation((callback) => {
    changed = callback;
    return () => {};
  });
  vi.mocked(savedDownloadStatus).mockResolvedValue(true);
  vi.mocked(openSavedDownload).mockResolvedValue("opened");
  const again = heldDownload();
  vi.mocked(downloadNativeMedia).mockReturnValueOnce(again.promise);
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Open report.pdf",
  });
  fireEvent.contextMenu(button, { clientX: 20, clientY: 20 });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Download again" }),
  );
  await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(savedDownloadStatus).toHaveBeenCalledTimes(1);

  // Another card's save tells every card to ask again. This one is busy.
  await act(async () => changed());
  expect(savedDownloadStatus).toHaveBeenCalledTimes(1);
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveTextContent("Downloading…");
  fireEvent.click(button);
  expect(openSavedDownload).not.toHaveBeenCalled();

  await act(async () => again.reject(new Error("offline")));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t download report.pdf. Try again.",
    ),
  );
  // The card asked whether the earlier copy is still saved. It is.
  expect(savedDownloadStatus).toHaveBeenCalledTimes(2);
  expect(button).toHaveAccessibleName("Retry download report.pdf");
  expect(button).toHaveTextContent("Couldn’t download · Retry");
  expect(button).toHaveAttribute("aria-busy", "false");
  fireEvent.contextMenu(button, { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
  await waitFor(() => expect(button).toHaveAccessibleName("Open report.pdf"));
  expect(openSavedDownload).toHaveBeenCalledWith(
    nativeSource,
    "report.pdf",
    false,
  );
  expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
});

it("keeps a failed download on the card and recovers through retry", async () => {
  const failed = heldDownload();
  const retried = heldDownload();
  vi.mocked(downloadNativeMedia)
    .mockReturnValueOnce(failed.promise)
    .mockReturnValueOnce(retried.promise);
  render(
    <FileAttachment
      attachment={file}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
  await act(async () => failed.reject(new Error("unavailable")));
  const retry = screen.getByRole("button", {
    name: "Retry download report.pdf",
  });
  expect(retry).toHaveTextContent("Couldn’t download · Retry");
  expect(screen.getByRole("alert")).toHaveClass("sr-only");
  // Nothing was saved, so there is no saved copy's menu.
  fireEvent.contextMenu(retry, { clientX: 20, clientY: 20 });
  await act(async () => {});
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(retry);
  expect(retry).toHaveTextContent("Downloading…");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => retried.resolve());
  expect(retry).toHaveTextContent("1 KB · Downloaded");
  expect(downloadNativeMedia).toHaveBeenCalledTimes(2);
});

it.each(["success", "failure"])(
  "retires an old source's pending %s result",
  async (result) => {
    const old = heldDownload();
    vi.mocked(downloadNativeMedia).mockReturnValueOnce(old.promise);
    const { rerender } = render(
      <FileAttachment
        attachment={file}
        source={nativeSource}
        onOpenLink={() => false}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const replacement = nativeSource.replace(".pdf", ".txt");
    rerender(
      <FileAttachment
        attachment={file}
        source={replacement}
        onOpenLink={() => false}
      />,
    );
    await act(async () =>
      result === "success"
        ? old.resolve()
        : old.reject(new Error("old failure")),
    );
    expect(screen.getByRole("button")).toHaveTextContent("1 KB");
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  },
);

import { assert, afterEach, expect, it, vi } from "vitest";
import {
  attachmentMessage,
  brokerUpload,
  readUploadResponse,
  UPLOAD_MAX_BYTES,
  validateUploadResult,
} from "./attachments";
import { foldMessages, parseAttachments } from "./fold";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const origin = "https://relay.test";
const hash = "a".repeat(64);
const descriptor = {
  url: `${origin}/media/${hash}.pdf`,
  type: "application/pdf",
  size: 3,
  sha256: hash,
};
const file = new File([new Uint8Array([0, 128, 255])], "report.pdf", {
  type: "application/pdf",
});
afterEach(() => vi.unstubAllGlobals());

it("uploads exact bytes through the selected broker and returns frozen named metadata", async () => {
  const fetcher = vi.fn(async (_url, options) => {
    expect(new Uint8Array(await options.body.arrayBuffer())).toEqual(
      new Uint8Array([0, 128, 255]),
    );
    return Response.json(descriptor);
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await brokerUpload("/api/relay/selected", origin)(
    file,
    new AbortController().signal,
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/api/relay/selected/upload",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: file,
    }),
  );
  expect(result).toEqual({ ...descriptor, name: "report.pdf" });
  expect(Object.isFrozen(result)).toBe(true);
});

it.each([
  { url: `https://other.test/media/${hash}.pdf` },
  { url: `${origin}/media/${hash}.pdf?token=x` },
  { url: `${origin}/media/${hash}.pdf#fragment` },
  { url: `https://user@relay.test/media/${hash}.pdf` },
  { url: `${origin}/media/${"b".repeat(64)}.pdf` },
  { url: `${origin}/other/${hash}.pdf` },
  { type: "text/html; extra" },
  { size: 4 },
  { sha256: "invalid" },
])("rejects an invalid descriptor independently: %j", (patch) => {
  expect(() =>
    validateUploadResult({ ...descriptor, ...patch }, origin, 3, "file"),
  ).toThrow(/invalid upload/);
});

it.each([0, UPLOAD_MAX_BYTES + 1])(
  "rejects size %s before network work",
  async (size) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      brokerUpload("/api/relay", origin)(
        Object.defineProperty(new File(["x"], "file"), "size", { value: size }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "size" });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each(["capacity", "failed"])("preserves broker failure %s", async (code) => {
  vi.stubGlobal("fetch", async () => Response.json({ code }, { status: 400 }));
  await expect(
    brokerUpload("/api/relay", origin)(file, new AbortController().signal),
  ).rejects.toMatchObject({ code });
});

it("rejects oversized/malformed bodies and cancels response consumption", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8193));
          },
          cancel,
        }),
      ),
  );
  await expect(
    brokerUpload("/api/relay", origin)(file, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(cancel).toHaveBeenCalledTimes(1);
  vi.stubGlobal("fetch", async () => new Response("not json"));
  await expect(
    brokerUpload("/api/relay", origin)(file, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});

it("passes cancellation to fetch and rejects late completion", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      assert.exists(init?.signal);
      controller.abort();
      expect(init.signal.aborted).toBe(true);
      return Response.json(descriptor);
    },
  );
  await expect(
    brokerUpload("/api/relay", origin)(file, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    brokerUpload("/api/relay", origin)(file, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("builds escaped message links and metadata understood by the existing receiver", () => {
  const uploaded = { ...descriptor, name: "[report](x)\n!.pdf" };
  const result = attachmentMessage(" hello ", [uploaded], origin);
  expect(result.content).toBe(
    `hello\n\n[\\[report\\]\\(x\\) \\!.pdf](<${descriptor.url}>)`,
  );
  expect(result.tags).toEqual([
    [
      "imeta",
      `url ${descriptor.url}`,
      "m application/pdf",
      "size 3",
      `x ${hash}`,
      "filename [report](x) !.pdf",
    ],
  ]);
  const received = parseAttachments(
    { id: "", pubkey: "", kind: 9, created_at: 1, ...result },
    [],
  );
  expect(received).toMatchObject([
    {
      kind: "file",
      name: "[report](x) !.pdf",
      size: 3,
      mime: "application/pdf",
    },
  ]);
  expect(() =>
    attachmentMessage("", [uploaded], "https://different.test"),
  ).toThrow();
});

it.each(["report &copy;.pdf", "report &#65;.pdf", "report &#x41;.pdf"])(
  "preserves the literal filename %s through message projection",
  (name) => {
    const message = attachmentMessage(
      "hello",
      [{ ...descriptor, name }],
      origin,
    );
    const [received] = foldMessages("c", "d".repeat(64), [
      {
        id: "b".repeat(64),
        pubkey: "c".repeat(64),
        created_at: 1,
        kind: 9,
        content: message.content,
        tags: [["h", "c"], ...message.tags],
      },
    ]);
    expect(received?.content).toBe("hello");
    expect(received?.attachments).toEqual([
      {
        url: descriptor.url,
        kind: "file",
        mime: descriptor.type,
        size: 3,
        name,
      },
    ]);
  },
);

it("keeps ordinary text unchanged and marks prepared image/video links as media", () => {
  expect(attachmentMessage(" hello ", [])).toEqual({
    content: "hello",
    tags: [],
  });
  for (const type of ["image/png", "video/mp4"]) {
    const result = attachmentMessage(
      "",
      [{ ...descriptor, name: "media", type }],
      origin,
    );
    expect(result.content).toBe(`![media](<${descriptor.url}>)`);
  }
});

const image = {
  ...descriptor,
  url: `${origin}/media/${hash}.png`,
  type: "image/png",
};

it("carries relay-measured image dimensions into imeta for receiver layout", () => {
  const uploaded = validateUploadResult(
    { ...image, dim: "1280x400" },
    origin,
    3,
    "shot.png",
  );
  const result = attachmentMessage("", [uploaded], origin);
  expect(result.tags[0]).toContain("dim 1280x400");
  expect(
    parseAttachments(
      { id: "", pubkey: "", kind: 9, created_at: 1, ...result },
      [],
    )[0]?.dimensions,
  ).toEqual({ width: 1280, height: 400 });
});

it.each(["1280 x 400", "1280x400x2", 1280, "-1x4"])(
  "drops malformed relay dimensions %j without failing the upload",
  (dim) => {
    expect(
      validateUploadResult({ ...image, dim }, origin, 3, "shot.png"),
    ).not.toHaveProperty("dim");
  },
);

it.each([
  [401, "denied"],
  [403, "denied"],
  [413, "size"],
  [429, "capacity"],
])(
  "preserves HTTP %s without requiring an error body",
  async (status, code) => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(null, { status: Number(status) }),
    );
    await expect(
      brokerUpload("/api/relay", origin)(file, new AbortController().signal),
    ).rejects.toMatchObject({ code });
  },
);

it("bounds a stalled request and rejects its late result after the upload deadline", async () => {
  vi.useFakeTimers();
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  const started = deferred<void>();
  vi.stubGlobal("fetch", (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.exists(init?.signal);
    signal = init.signal;
    started.resolve();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    const pending = brokerUpload("/api/relay", origin)(
      file,
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await started.promise;
    expect(timeout).toHaveBeenCalledWith(600_000);
    deadline.abort(new DOMException("Upload deadline", "TimeoutError"));
    expect(signal.aborted).toBe(true);
    release(Response.json(descriptor));
    await rejected;
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps filename metadata within the relay basename and UTF-8 byte rules", () => {
  for (const name of [
    "folder/name\\other\u0085.pdf",
    "📎".repeat(100),
    " /\\\u0085 ",
  ]) {
    const result = attachmentMessage("", [{ ...descriptor, name }], origin);
    const field = result.tags[0]?.find((item) => item.startsWith("filename "));
    assert.exists(field);
    const value = field.slice("filename ".length);
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(255);
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toContain("/");
    expect(value).not.toContain("\\");
    expect(value).not.toContain("\u0085");
  }
});

it("removes deceptive bidi controls from both metadata and the sent Markdown label", () => {
  const controls =
    "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  const result = attachmentMessage(
    "",
    [{ ...descriptor, name: `report${controls}.pdf` }],
    origin,
  );
  for (const char of controls) {
    expect(result.content).not.toContain(char);
    expect(result.tags.flat().join(" ")).not.toContain(char);
  }
});

it("uploads prepared video bytes rather than the original, preserving the preparation boundary", async () => {
  const source = new File(
    [new Uint8Array([0x46, 0x4c, 0x56, 1]), "source metadata"],
    "clip.flv",
    { type: "video/x-flv" },
  );
  const converted = new Uint8Array([
    0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109,
  ]);
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/prepare-media")) {
      expect(init.body).toBe(source);
      return new Response(converted, {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(converted.length),
        },
      });
    }
    const sent = init.body as File;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(converted);
    expect(sent.name).toBe("clip.mp4");
    return Response.json({
      ...descriptor,
      type: "video/mp4",
      size: converted.length,
    });
  });
  const result = await brokerUpload("/api/relay", origin)(
    source,
    new AbortController().signal,
  );
  expect(result.size).toBe(converted.length);
  expect(calls).toEqual(["/api/relay/prepare-media", "/api/relay/upload"]);
});

it("cancellation during preparation cannot start a later upload", async () => {
  const started = deferred<void>();
  const release = deferred<Response>();
  const cancel = new AbortController();
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    expect(init.signal).toBeDefined();
    started.resolve();
    return release.promise;
  });
  vi.stubGlobal("fetch", fetch);
  const pending = brokerUpload("/api/relay", origin)(
    new File(["FLV\x01source"], "clip.flv"),
    cancel.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await started.promise;
  cancel.abort();
  release.resolve(
    new Response("prepared", {
      headers: { "Content-Type": "video/mp4", "Content-Length": "8" },
    }),
  );
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["M4A ", "zzzz"])(
  "leaves non-video BMFF %s to relay rejection, without conversion",
  async (brand) => {
    const data = Uint8Array.from(
      `\0\0\0\x14ftyp${brand}\0\0\0\0${brand}`,
      (char) => char.charCodeAt(0),
    );
    const source = new File([data], "ordinary.bin", {
      type: "application/octet-stream",
    });
    const fetcher = vi.fn(async () =>
      Response.json({ code: "rejected" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      brokerUpload("/api/relay", origin)(source, new AbortController().signal),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/relay/upload",
      expect.objectContaining({ body: source }),
    );
  },
);

it.each([
  [
    422,
    "video resolution too high: maximum is 2160 on the short edge and 3840 on the long edge",
    "resolution",
  ],
  [422, "video too long: duration exceeds 600 seconds", "duration"],
  [
    415,
    "unsupported media codec: only H.264 video and AAC audio are accepted",
    "codec",
  ],
  [415, "unsupported container: only MP4 is accepted", "rejected"],
  [422, "moov atom not at front of file (not fast-start)", "rejected"],
])("names the relay's %i video rule: %s", async (status, error, code) => {
  await expect(
    readUploadResponse(Response.json({ error }, { status })),
  ).rejects.toMatchObject({ code });
});

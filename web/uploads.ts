import {
  mediaByteLimit,
  UPLOAD_MAX_BYTES,
} from "../src/features/relay/attachment-limits.ts";
import { UploadError } from "../src/features/relay/attachments.ts";
import type { Handler } from "./commands.ts";

// Native relay_upload_* (src-tauri/src/relay.rs) in the page: chunks gather
// into a Blob, HEIC, video and voice notes are converted in a media Worker,
// the key Worker signs the Blossom token for the exact bytes, and XHR sends
// them with progress (fetch can't report upload progress).

type Upload = {
  size: number;
  received: number;
  chunks: ArrayBuffer[];
  abort: AbortController;
};
const uploads = new Map<string, Upload>();
let preparing = 0;

function upload(headers: Headers) {
  const id = headers.get("x-buzz-upload-id") ?? "";
  const found = uploads.get(id);
  if (!found) throw "Invalid upload ID";
  return [id, found] as const;
}

/** Converts like native `prepare_file`, at most two at a time. */
async function prepare(mode: string, file: Blob, signal: AbortSignal) {
  const kind = mode.split(":")[0] ?? "";
  if (!["image", "video", "voice"].includes(kind))
    throw new UploadError("video");
  if (preparing >= 2) throw new UploadError("capacity");
  preparing++;
  const worker = new Worker(new URL("./media-worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const { data } = await new Promise<MessageEvent>((resolve, reject) => {
      worker.onmessage = resolve;
      worker.onerror = reject;
      signal.addEventListener("abort", () => reject(signal.reason));
      worker.postMessage({ kind, file });
    }).catch((error) => {
      throw signal.aborted ? error : new UploadError("video");
    });
    if (!data.file)
      throw data.error
        ? new Error(data.error)
        : new UploadError(kind === "image" ? "image" : "video");
    if (data.file.size > mediaByteLimit(data.file.type))
      throw new UploadError("size");
    return data.file as Blob;
  } finally {
    worker.terminate();
    preparing--;
  }
}

function put(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  progress: string | null,
  signal: AbortSignal,
) {
  return new Promise<{ status: number; headers: object; body: string }>(
    (resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      for (const [name, value] of Object.entries(headers))
        xhr.setRequestHeader(name, value);
      // Progress goes to the Tauri Channel (`__CHANNEL__:<callback id>`).
      const channel = Number(progress?.match(/^__CHANNEL__:(\d+)$/)?.[1]);
      let index = 0;
      if (channel)
        xhr.upload.onprogress = ({ loaded }) =>
          Reflect.get(window, "__TAURI_INTERNALS__").runCallback(channel, {
            index: index++,
            message: { sent: loaded, total: body.size },
          });
      xhr.onload = () =>
        resolve({ status: xhr.status, headers: {}, body: xhr.responseText });
      xhr.onerror = () => reject("Upload did not finish");
      xhr.onabort = () => reject("Upload cancelled");
      signal.addEventListener("abort", () => xhr.abort());
      xhr.send(body);
    },
  );
}

export const uploadCommands = (key: Handler): Record<string, Handler> => ({
  relay_upload_begin({ id, size }) {
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id))
      throw "Invalid upload ID";
    if (!Number.isSafeInteger(size) || size < 1 || size > UPLOAD_MAX_BYTES)
      throw "Invalid upload size";
    if (uploads.has(id)) throw "Upload is already in progress";
    if (uploads.size >= 64) throw "Uploads are busy";
    uploads.set(id, {
      size,
      received: 0,
      chunks: [],
      abort: new AbortController(),
    });
  },
  relay_upload_chunk(bytes, _, headers) {
    const [id, target] = upload(headers);
    if (
      !(bytes instanceof ArrayBuffer) ||
      Number(headers.get("x-buzz-upload-offset")) !== target.received ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 64 * 1024 ||
      target.received + bytes.byteLength > target.size
    ) {
      uploads.delete(id);
      throw "Invalid upload chunk";
    }
    target.chunks.push(bytes);
    target.received += bytes.byteLength;
  },
  async relay_upload(_, __, headers) {
    const [id, target] = upload(headers);
    const { signal } = target.abort;
    try {
      if (target.received !== target.size) throw "Invalid upload chunk";
      const mode = headers.get("x-buzz-preparation");
      const file = mode
        ? await prepare(mode, new Blob(target.chunks), signal)
        : new Blob(target.chunks, {
            type: headers.get("x-buzz-content-type") ?? "",
          });
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const { url, authorization } = (await key(
        { community: headers.get("x-buzz-community"), sha256 },
        "relay_upload",
        headers,
      )) as { url: string; authorization: string };
      signal.throwIfAborted();
      return await put(
        url,
        {
          Authorization: authorization,
          "Content-Type": file.type || "application/octet-stream",
          "X-SHA-256": sha256,
        },
        file,
        headers.get("x-buzz-upload-progress"),
        signal,
      );
    } finally {
      uploads.delete(id);
    }
  },
  relay_upload_cancel({ id }) {
    uploads.get(id)?.abort.abort("Upload cancelled");
    uploads.delete(id);
  },
});

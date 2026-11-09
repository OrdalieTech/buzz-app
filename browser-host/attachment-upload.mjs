import { createReadStream } from "node:fs";
import { finished } from "node:stream/promises";
import { finalizeEvent } from "nostr-tools";
import { receiveAttachment } from "./attachment-file.mjs";
import {
  imageType,
  mediaByteLimit,
  relayRejection,
  UPLOAD_MAX_BYTES,
  UPLOAD_TIMEOUT_MS,
} from "../src/features/relay/attachment-limits.ts";
import { videoDemuxer } from "../src/features/relay/video-preparation.ts";
export { UPLOAD_MAX_BYTES, UPLOAD_TIMEOUT_MS };
export class UploadError extends Error {
  constructor(code, status = 400) {
    super(`Attachment upload: ${code}`);
    this.code = code;
    this.status = status;
  }
}

// The relay owns content sniffing, metadata rejection and membership admission.
// Never trust a browser MIME hint or a relay-provided URL as proof of safe content.
export async function uploadAttachment(req, relay, key, fetchUpstream, signal) {
  const type = req.headers["content-type"] || "application/octet-stream";
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type))
    throw new UploadError("rejected");
  if (Number(req.headers["content-length"]) > UPLOAD_MAX_BYTES)
    throw new UploadError("size", 413);
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  ]);
  const spool = await receiveAttachment(
    req,
    UPLOAD_MAX_BYTES,
    bounded,
    () => new UploadError("size", 413),
  );
  let body;
  try {
    bounded.throwIfAborted();
    const { size, sha256 } = spool;
    const detected =
      imageType(spool.header) ??
      (videoDemuxer(spool.header) ? "video/mp4" : "application/octet-stream");
    if (size > mediaByteLimit(detected)) throw new UploadError("size", 413);
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent(
      {
        kind: 24242,
        created_at: now,
        content: "Upload attachment",
        tags: [
          ["t", "upload"],
          ["x", sha256],
          ["server", new URL(relay).host],
          [
            "expiration",
            String(now + Math.ceil(UPLOAD_TIMEOUT_MS / 1000) + 60),
          ],
        ],
      },
      key,
    );
    body = createReadStream(spool.path, { signal: bounded });
    // Attach before fetch: cancellation can race stream opening.
    const closed = finished(body).catch(() => {});
    let response;
    try {
      response = await fetchUpstream(`${relay}/upload`, {
        method: "PUT",
        redirect: "error",
        signal: bounded,
        headers: {
          "Content-Type": type,
          "Content-Length": String(size),
          "X-SHA-256": sha256,
          Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`,
        },
        body,
        duplex: "half",
      });
    } finally {
      body.destroy();
      await closed;
    }
    // These statuses do not need error text; cancel rather than read their bodies.
    const status = response.status;
    if (!response.ok && ![400, 415, 422].includes(status)) {
      try {
        await response.body?.cancel();
      } catch {
        // Cleanup failure must not replace a status we already received.
      }
      if (status === 413) throw new UploadError("size", 413);
      if (status === 429) throw new UploadError("capacity", 429);
      if ([401, 403].includes(status)) throw new UploadError("denied", 403);
      throw new UploadError("failed", 502);
    }
    // Bound response bytes, not decoded characters; cancel oversized streams.
    const reader = response.body?.getReader();
    if (!reader) throw new UploadError("invalid", 502);
    const parts = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 8192) throw new UploadError("invalid", 502);
        parts.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    bounded.throwIfAborted();
    const text = Buffer.concat(parts).toString("utf8");
    if (!response.ok) throw new UploadError(relayRejection(text));
    let v, url;
    try {
      v = JSON.parse(text);
      url = new URL(v.url, relay);
    } catch {
      throw new UploadError("invalid", 502);
    }
    if (
      typeof v.url !== "string" ||
      typeof v.type !== "string" ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(v.type) ||
      v.size !== size ||
      v.sha256 !== sha256 ||
      url.origin !== new URL(relay).origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !new RegExp(`^/media/${sha256}(?:\\.[a-z0-9]{1,8})?$`).test(url.pathname)
    )
      throw new UploadError("invalid", 502);
    // The app validates `dim` like the native path; the broker only forwards it.
    return {
      url: url.href,
      type: v.type,
      size,
      sha256,
      ...(typeof v.dim === "string" ? { dim: v.dim } : {}),
    };
  } finally {
    await spool.cleanup();
  }
}

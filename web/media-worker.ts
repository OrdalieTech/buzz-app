import {
  ADTS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  FLAC,
  Input,
  MATROSKA,
  MP3,
  MP4,
  Mp4OutputFormat,
  OGG,
  Output,
  QTFF,
  QUALITY_LOW,
  WAVE,
  WEBM,
} from "mediabunny";
import { cleanEncodedJpeg } from "../src/features/messages/jpeg-metadata.ts";

// The browser's stand-in for native media preparation
// (src-tauri/src/relay/media_preparation.rs): HEIC to JPEG, video and voice
// notes to the fast-start H.264/AAC MP4 without metadata the relay requires.
// One Worker per file; the page terminates it to cancel.

/** A failure the user can act on; anything else is a generic conversion error. */
class Refusal extends Error {}
const unreadable = () =>
  new Refusal(
    "This browser can't read this file's format. Export it as an H.264 MP4 or try Safari, then retry.",
  );

/** Decodes with the browser's own image codecs (Safari reads HEIC). */
async function jpeg(file: Blob) {
  const image = await createImageBitmap(file).catch(() => {
    throw new Refusal(
      "This browser can't open HEIC photos. Use Safari or export the photo as JPEG, then retry.",
    );
  });
  if (image.width * image.height > 25_000_000)
    throw new Refusal("Choose an image with at most 25 million pixels.");
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  const encoded = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: 0.95,
  });
  return cleanEncodedJpeg(new Uint8Array(await encoded.arrayBuffer()));
}

/** The relay allows only the boxes ffmpeg writes; mediabunny adds `cslg` for
 * B-frames, so it becomes a `free` box of the same size. */
function withoutCslg(bytes: Uint8Array, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer);
  for (let at = start; at + 8 <= end; ) {
    const size = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size < 8) break;
    if (kind === "cslg") bytes.set([0x66, 0x72, 0x65, 0x65], at + 4);
    if (["moov", "trak", "mdia", "minf", "stbl"].includes(kind))
      withoutCslg(bytes, at + 8, at + size);
    at += size;
  }
}

/** ffmpeg's `-map 0:v:0 -map 0:a:0? -map_metadata -1 -movflags +faststart`,
 * scaled into the relay's 3840x2160 envelope. A voice note gets a black 16x16
 * video track instead, since the relay refuses audio-only files. */
async function mp4(file: Blob, voice: boolean) {
  const input = new Input({
    source: new BlobSource(file),
    formats: [MP4, QTFF, MATROSKA, WEBM, WAVE, OGG, MP3, ADTS, FLAC],
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    composable: voice,
    ...(voice ? {} : { tags: {} }),
    showWarnings: false,
    video: ({ displayWidth: w, displayHeight: h }) => {
      const scale = Math.min(1, 3840 / Math.max(w, h), 2160 / Math.min(w, h));
      if (voice) return { discard: true };
      if (scale === 1) return { codec: "avc" };
      const even = (edge: number) => Math.round((edge * scale) / 2) * 2;
      return { codec: "avc", width: even(w), height: even(h), fit: "fill" };
    },
    audio: { codec: "aac" },
  }).catch(() => {
    throw unreadable();
  });
  const reasons = conversion.discardedTracks
    .map(({ reason }) => reason)
    .filter((reason) => reason !== "discarded_by_user");
  if (reasons.includes("no_encodable_target_codec"))
    throw new Refusal(
      "This browser can't encode H.264 video or AAC audio. Use a recent Chrome, Edge or Safari, then retry.",
    );
  if (reasons.length || !conversion.isValid) throw unreadable();
  if (voice) {
    const audio = await input.getPrimaryAudioTrack();
    if (!audio) throw unreadable();
    const canvas = new OffscreenCanvas(16, 16);
    canvas.getContext("2d")?.fillRect(0, 0, 16, 16);
    const black = new CanvasSource(canvas, {
      codec: "avc",
      quality: QUALITY_LOW,
    });
    output.addVideoTrack(black, { frameRate: 1 });
    await output.start();
    const duration = await audio.computeDuration();
    const sound = conversion.execute();
    for (let second = 0; second < duration; second++)
      await black.add(second, Math.min(1, duration - second));
    black.close();
    await sound;
    await output.finalize();
  } else await conversion.execute();
  const bytes = new Uint8Array(output.target.buffer ?? new ArrayBuffer(0));
  withoutCslg(bytes);
  return new Blob([bytes], { type: "video/mp4" });
}

self.onmessage = async ({ data: { kind, file } }) => {
  try {
    self.postMessage({
      file:
        kind === "image" ? await jpeg(file) : await mp4(file, kind === "voice"),
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Refusal ? error.message : "" });
  }
};

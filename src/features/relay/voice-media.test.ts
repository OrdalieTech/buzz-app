import { expect, test, vi } from "vitest";
import { validateRecording } from "./voice-media";
import { attachmentDraft } from "../messages/attachment-draft";
import { attachmentMessage } from "./attachments";
import { parseAttachments, foldMessages } from "./fold";
import { keypair, message } from "./testing";
import type { RelaySession } from "./session";

const file = new File([new Uint8Array(48044)], "voice-note-test.wav", {
  type: "audio/wav",
});
const recording = { file, duration: 1, waveform: [0, 0.25, 0, 1] };
const uploaded = {
  url: `https://relay.test/media/${"a".repeat(64)}.mp4`,
  name: "voice-note-test.mp4",
  type: "video/mp4",
  size: 1000,
  sha256: "a".repeat(64),
};

test("the existing attachment queue carries voice metadata through upload, retry and message projection", async () => {
  const upload = vi.fn().mockResolvedValue(uploaded);
  const session = { attachments: { upload } } as unknown as RelaySession;
  const draft = attachmentDraft(session, "draft", "general");
  draft.add([file], recording);
  expect(upload).not.toHaveBeenCalled();
  const results = await draft.prepareForSend(new AbortController().signal);
  expect(results[0]?.voice).toEqual({ duration: 1, waveform: [0, 25, 0, 100] });
  expect(await draft.prepareForSend(new AbortController().signal)).toEqual(
    results,
  );
  expect(upload).toHaveBeenCalledTimes(1);
  const body = attachmentMessage("Caption", results, "https://relay.test");
  const sender = keypair();
  const event = message(sender, "general", body.content, 1, body.tags);
  const row = foldMessages("general", sender.pubkey, [event])[0];
  expect(row?.attachments[0]).toMatchObject({
    kind: "audio",
    voiceNote: true,
  });
  expect(row?.content).toBe("Caption");
  // block/buzz handlers/imeta.rs accepts these fields; waveform is rejected,
  // and capture duration can differ from the stored 1 fps video duration.
  expect(body.tags).toEqual([
    [
      "imeta",
      `url ${uploaded.url}`,
      "m video/mp4",
      "size 1000",
      `x ${uploaded.sha256}`,
      "filename voice-note-test.mp4",
    ],
  ]);
  expect(row?.attachments[0]?.duration).toBeUndefined();
  expect(row?.attachments[0]?.waveform).toBeUndefined();
});
test("old voice notes are recognized even when their Markdown label is not the filename", () => {
  const event = message(keypair(), "general", "", 1, [
    [
      "imeta",
      `url ${uploaded.url}`,
      "m video/mp4",
      "filename voice-note-test.mp4",
      "waveform 0 20 0",
    ],
  ]);
  const [attachment] = parseAttachments(
    event,
    [],
    new Map([[uploaded.url, "Voice note"]]),
  );
  expect(attachment).toMatchObject({
    name: "Voice note",
    kind: "audio",
    voiceNote: true,
    waveform: [0, 20, 0],
  });
});
test.each([[NaN], [-1], [1.01], []].map((waveform) => ({ waveform })))(
  "rejects invalid recorded amplitudes %j",
  ({ waveform }) => {
    expect(() => validateRecording({ ...recording, waveform })).toThrow();
  },
);
test.each(["NaN", "-1", "101", "0.5"])(
  "ignores malformed incoming waveform %s",
  (waveform) => {
    const event = message(keypair(), "general", "", 1, [
      ["imeta", `url ${uploaded.url}`, "m video/mp4", `waveform ${waveform}`],
    ]);
    expect(parseAttachments(event, [])[0]?.waveform).toBeUndefined();
  },
);
test("rejects malformed outgoing voice metadata before signing", () => {
  expect(() =>
    attachmentMessage(
      "",
      [{ ...uploaded, voice: { duration: Infinity, waveform: [10] } }],
      "https://relay.test",
    ),
  ).toThrow();
});

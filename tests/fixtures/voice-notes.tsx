// Disposable fixture: actual plugin, composer, session and outbox; no live identity or uploads.
import { Context } from "@deepseek-ai/cordis";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntime } from "../../src/plugins/runtime";
import { ConversationService } from "../../src/features/conversation/service";
import * as voiceNotes from "../../src/bundled/voice-notes";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  message,
  signed,
  metadata,
  roster,
  bounds,
} from "../../src/features/relay/testing";
import { encodeVoiceNoteWav } from "../../src/bundled/voice-notes/voiceNoteWav";
import { isVoiceNoteFile } from "../../src/bundled/voice-notes/audio";
import {
  attachmentMessage,
  type UploadedAttachment,
} from "../../src/features/relay/attachments";
import { PublishRejected } from "../../src/features/relay/outbox";
import { attachmentDraft } from "../../src/features/messages/attachment-draft";
import "../../src/shared/styles/globals.css";

const viewer = keypair(),
  authority = keypair();
const root = new Context();
const runtime = new PluginRuntime(root, async () => voiceNotes);
const conversation = new ConversationService(root);
const plugin = {
  manifest: {
    id: "buzz.voice-notes",
    name: "Voice Notes",
    apiVersion: 1 as const,
  },
  enabled: true,
  source: "bundled" as const,
  revision: "one",
  previous: null,
  error: null,
};
const wav = encodeVoiceNoteWav(
  [Float32Array.from({ length: 72000 }, (_, n) => Math.sin(n / 12) * 0.25)],
  24000,
);
const initialAudio = URL.createObjectURL(
  new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
);
const attachment: UploadedAttachment = {
  url: "https://fixture.test/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4",
  type: "video/mp4",
  name: "voice-note-demo.mp4",
  voice: { duration: 3, waveform: [0, 20, 85, 20, 0, 40, 100, 40, 0] },
  sha256: "a".repeat(64),
  size: 5000,
};
const urls = new Map([[attachment.url, initialAudio]]);
const initial = message(
  viewer,
  "general",
  `The voice-note card from the old Buzz app.\n[Voice note](${attachment.url})`,
  1,
  attachmentMessage("", [attachment], "https://fixture.test").tags,
);
const events = [initial];
const report = {
  uploads: 0,
  published: 0,
  failUpload: false,
  failSend: false,
  delayUpload: false,
};
let receive = (_events: typeof events) => {};
const owner = createRelaySession(
  {
    scope: "https://fixture.test",
    viewer: viewer.pubkey,
    relayAuthor: authority.pubkey,
    media: (url) =>
      urls.has(url)
        ? `/api/relay/media?url=${encodeURIComponent(url)}`
        : undefined,
    subscribe: (callbacks) => {
      receive = callbacks.receive;
      return { update() {}, retry() {}, dispose() {} };
    },
    async uploadAttachment(file, signal) {
      const upload = ++report.uploads;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, report.delayUpload ? 2000 : 80);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Cancelled", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      if (report.failUpload) throw new Error("Fixture upload failed");
      const voice = isVoiceNoteFile(file);
      const result: UploadedAttachment = {
        type: voice ? attachment.type : file.type || "application/octet-stream",
        ...(voice && attachment.voice ? { voice: attachment.voice } : {}),
        name: voice ? file.name.replace(/\.wav$/, ".mp4") : file.name,
        url: `https://fixture.test/media/${upload.toString(16).padStart(64, "0")}.mp4`,
        sha256: upload.toString(16).padStart(64, "0"),
        size: file.size,
      };
      // The fixture only exercises local delivery; retain exact captured bytes for playback.
      urls.set(result.url, URL.createObjectURL(file));
      return result;
    },
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(39002))
          return [
            roster(authority, "general", [viewer.pubkey]),
            roster(authority, "other", [viewer.pubkey]),
          ];
        if (filter.kinds?.includes(39000))
          return [
            metadata(authority, "general", "General"),
            metadata(authority, "other", "Other"),
          ];
        if (filter["#h"])
          return [
            ...events.filter((e) =>
              e.tags.some(
                (t) => t[0] === "h" && filter["#h"]?.includes(t[1] ?? ""),
              ),
            ),
            bounds(authority, filter["#h"][0] ?? "general", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return [];
      });
    },
    writer: {
      kinds: [9],
      async sign(template) {
        return signed(viewer, template);
      },
      async publish(event) {
        report.published++;
        if (report.failSend)
          throw new PublishRejected("Fixture message rejected");
        events.push(event);
        receive([event]);
      },
    },
  },
  { outboxStorage: { load: () => [], save() {} } },
);
owner.session.channels.ensureList();
owner.session.channels.ensure("general");
runtime.reconcile([plugin]);
Object.assign(window, {
  voiceFixture: {
    report,
    media: (url: string) => urls.get(url),
    attachmentDraft: (key: string, channelId: string) =>
      attachmentDraft(owner.session, key, channelId),
    toggle: (enabled: boolean) => runtime.reconcile(enabled ? [plugin] : []),
  },
});
function Preview() {
  const [channel, setChannel] = useState("general");
  const [enabled, setEnabled] = useState(true);
  const list = useSyncExternalStore(
    owner.session.channels.subscribeList,
    owner.session.channels.list,
  );
  useEffect(() => {
    if (list.status === "ready") owner.session.channels.ensure(channel);
  }, [list.status, channel]);
  const state = useSyncExternalStore(
    (listener) => owner.session.channels.subscribeWindow(channel, listener),
    () => owner.session.channels.window(channel),
  );
  return (
    <main style={{ maxWidth: 760, margin: "60px auto", padding: 24 }}>
      <h1>Voice Notes</h1>
      <p>
        Local preview. Recordings stay on this device; messages use a disposable
        test conversation.
      </p>
      <nav style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => {
            const next = channel === "general" ? "other" : "general";
            owner.session.channels.ensure(next);
            setChannel(next);
          }}
        >
          Switch conversation
        </button>
        <button
          type="button"
          onClick={() => {
            setEnabled(!enabled);
            runtime.reconcile(!enabled ? [plugin] : []);
          }}
        >
          {enabled ? "Disable" : "Enable"} Voice Notes
        </button>
      </nav>
      <h2>#{channel}</h2>
      {state.rows.map((row) => (
        <conversation.ui.Message
          key={row.id}
          row={row}
          profile={{ name: "You" }}
          media={owner.session.media}
          onOpenLink={() => false}
          day={false}
          retry={(id) => owner.session.messages.retry(id)}
        />
      ))}
      <conversation.ui.Composer
        session={owner.session}
        scope="voice-fixture"
        channelId={channel}
        channelName={channel}
      />
    </main>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ToastProvider>
      <Preview />
    </ToastProvider>
  </StrictMode>,
);

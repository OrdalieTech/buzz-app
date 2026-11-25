import { GitHubBody } from "../../src/bundled/github/GitHubBody";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import * as emojiPlugin from "../../src/bundled/emoji";
import emojiManifest from "../../src/bundled/emoji/manifest.json";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { ActivityIndicatorPresentation } from "../../src/features/conversation/typing-presentation";
import type { Attachment } from "../../src/features/relay/contracts";
import { AttachmentImage } from "../../src/features/messages/AttachmentImage";
import { MediaAttachment } from "../../src/features/messages/MediaAttachment";
import { MediaReviewViewer } from "../../src/features/messages/MediaReviewViewer";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
  profile,
  signed,
} from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";

const ctx = new Context();
const manager = createPluginManager(ctx, {
  bundled: [
    { manifest: { ...emojiManifest, apiVersion: 1 }, module: emojiPlugin },
  ],
});
const extensions = new ConversationService(ctx);
window.addEventListener("pagehide", () => {
  void manager.dispose();
  void ctx.fiber.dispose();
});

// Isolated, ephemeral signing and publication. Nothing goes to the live relay.
const viewer = keypair(),
  relay = keypair(),
  designer = keypair(),
  helper = keypair();
const attachment = {
  url: "https://fixture.test/sample.mp4",
  name: "Review clip.mp4",
  kind: "video" as const,
  dimensions: { width: 640, height: 360 },
};
const portraitUrl = "https://fixture.test/portrait.png";
const gifPreview = new URLSearchParams(location.search).has("gif");
const photo: Attachment = {
  url: gifPreview
    ? "https://fixture.test/animated.gif"
    : "https://fixture.test/photo.png",
  name: "Photo preview",
  kind: "image",
  dimensions: { width: 640, height: 360 },
};
const secondPhoto: Attachment = {
  url: "https://fixture.test/second-photo.png",
  kind: "image",
  name: "Second photo",
};
const thirdPhoto: Attachment = {
  ...photo,
  url: "https://fixture.test/third-photo.png",
  name: "Third photo",
};
const photos = new URLSearchParams(location.search).has("gallery")
  ? [photo, secondPhoto, thirdPhoto]
  : [photo];
const rootMessage = message(viewer, "video-preview", "Media review", 1, [
  ["imeta", `url ${attachment.url}`, "m video/mp4"],
  ...(new URLSearchParams(location.search).has("multiple-videos")
    ? [["imeta", "url https://fixture.test/another.mp4", "m video/mp4"]]
    : []),
  ...photos.map((item) => [
    "imeta",
    `url ${item.url}`,
    item === photo && gifPreview ? "m image/gif" : "m image/png",
  ]),
]);
const emptyThread = new URLSearchParams(location.search).has("empty");
const compactTimestamps = new URLSearchParams(location.search).has(
  "timestamps",
);
// A working agent in the review thread: its conversation indicator, or with
// `agent-update` its recorded step after the viewer's own comment. With
// `agent-update=own` the step follows a comment the agent wrote itself. `steps`
// seeds a finished step of the same run first, `own-steps` does so after the
// agent's own comment, and `agents` makes that finished step another agent's.
// `between` puts the step between two of the viewer's comments, and `link`
// gives the step a link in its details. A `fixture-agent-done` event ends the
// agent's work; `fixture-agent-step` delivers the run's next step.
const agentWorking = new URLSearchParams(location.search).has("agent-working");
const agentUpdate = new URLSearchParams(location.search).get("agent-update");
const events = [
  rootMessage,
  message(
    designer,
    "video-preview",
    compactTimestamps
      ? "[00:00.5]No space after this timestamp."
      : "[00:00.5] This is the frame I mean. Try the timecode or my marker on the bar.",
    2,
    [["e", rootMessage.id, "", "reply"]],
  ),
  message(
    viewer,
    "video-preview",
    compactTimestamps
      ? "[00:01.3]"
      : "[00:01.3] The second transition feels good.",
    3,
    [["e", rootMessage.id, "", "reply"]],
  ),
  ...(agentUpdate?.startsWith("own")
    ? [
        message(designer, "video-preview", "I'll recheck the second cut.", 4, [
          ["e", rootMessage.id, "", "reply"],
        ]),
      ]
    : []),
  ...(agentUpdate === "steps" ||
  agentUpdate === "own-steps" ||
  agentUpdate === "agents"
    ? [
        message(
          agentUpdate === "agents" ? helper : designer,
          "video-preview",
          "Opening the clip",
          5,
          [
            ["e", rootMessage.id, "", "reply"],
            ["audience", "agents"],
          ],
        ),
      ]
    : []),
  ...(agentUpdate !== null
    ? [
        message(
          designer,
          "video-preview",
          agentUpdate === "link"
            ? "Rechecking the second cut against https://example.org/cut"
            : "Rechecking the second cut",
          6,
          [
            ["e", rootMessage.id, "", "reply"],
            ["audience", "agents"],
          ],
        ),
      ]
    : []),
  ...(agentUpdate === "between"
    ? [
        message(viewer, "video-preview", "Thanks, that reads well.", 7, [
          ["e", rootMessage.id, "", "reply"],
        ]),
      ]
    : []),
  profile(designer, {
    name: "Alex",
    picture: portraitUrl,
    ...(agentWorking ? { is_agent: true } : {}),
  }),
  profile(helper, { name: "Sam", is_agent: true }),
  profile(viewer, { name: "You" }),
];
// Keep selected and unselected reaction chips visible in the dark viewer fixture.
const reactionTarget = events.find(
  (event) => event.kind === 9 && event.id !== rootMessage.id,
);
if (reactionTarget) {
  for (const [author, content] of [
    [designer, "😆"],
    [viewer, "👍"],
  ] as const) {
    events.push(
      signed(author, {
        kind: 7,
        content,
        created_at: 4,
        tags: [
          ["h", "video-preview"],
          ["e", reactionTarget.id],
        ],
      }),
    );
  }
}
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: (url) =>
      url === portraitUrl
        ? "/shell-gradient.png"
        : url === secondPhoto.url
          ? "/bestie.png"
          : url === photo.url || url === thirdPhoto.url
            ? gifPreview
              ? "/tests/fixtures/attachment-media/animated.gif"
              : "/shell-gradient.png"
            : "/tests/fixtures/message-gallery/assets/sample.mp4",
    writer: {
      sign: async (template) => signed(viewer, template),
      publish: async (event) => {
        events.push(event);
      },
    },
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      const typing = () =>
        callbacks.receive([
          signed(designer, {
            kind: 20002,
            content: "",
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["h", "video-preview"],
              ["e", rootMessage.id, "", "reply"],
            ],
          }),
        ]);
      const step = () => {
        const next = message(designer, "video-preview", "Writing it up", 8, [
          ["e", rootMessage.id, "", "reply"],
          ["audience", "agents"],
        ]);
        events.push(next);
        callbacks.receive([next]);
      };
      window.addEventListener("fixture-typing", typing);
      window.addEventListener("fixture-agent-step", step);
      return {
        update() {},
        retry() {},
        dispose() {
          window.removeEventListener("fixture-typing", typing);
          window.removeEventListener("fixture-agent-step", step);
        },
      };
    },
    async query(filters) {
      if (
        new URLSearchParams(location.search).has("slow") &&
        filters.some((filter) => filter.ids || filter.depth_limit)
      )
        await new Promise((resolve) => setTimeout(resolve, 1200));
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
          return [
            roster(relay, "video-preview", [
              viewer.pubkey,
              designer.pubkey,
              helper.pubkey,
            ]),
            metadata(relay, "video-preview", "Video preview"),
          ];
        if (filter.ids)
          return new URLSearchParams(location.search).has("missing-root")
            ? []
            : events.filter((event) => filter.ids?.includes(event.id));
        if (filter.kinds?.includes(0))
          return events.filter((event) => event.kind === 0);
        if (filter.kinds?.includes(7))
          return events.filter((event) => event.kind === 7);
        if (filter.depth_limit)
          return (emptyThread ? [] : events).filter(
            (event) =>
              (event.kind === 9 || event.kind === 7) &&
              event.id !== rootMessage.id &&
              (!filter.thread_cursor ||
                event.created_at > filter.thread_cursor),
          );
        return [];
      });
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
await owner.session.read([
  { kinds: [39002, 39000], "#d": ["video-preview"], limit: 10 },
]);
const working = {
  status: "listening" as const,
  records: [],
  turns: [],
  typing: [],
  trimmed: 0,
  local: [
    {
      scope: "video-preview",
      agent: designer.pubkey,
      channelId: "video-preview",
      messageId: rootMessage.id,
      threadRootId: rootMessage.id,
      thread: true,
      state: "working" as const,
      startedAt: Date.now(),
      step: { tool: "Rechecking rather than replying from memory" },
    },
  ],
};
let agentWork = working;
const session = agentWorking
  ? {
      ...owner.session,
      agentActivity: {
        snapshot: () => agentWork,
        subscribe(listener: () => void) {
          const done = () => {
            agentWork = { ...working, local: [] };
            listener();
          };
          window.addEventListener("fixture-agent-done", done);
          return () => window.removeEventListener("fixture-agent-done", done);
        },
      },
    }
  : owner.session;
function Fixture() {
  useKeyboardFocusVisibility();
  const [review, setReview] = useState<
    { attachment: Attachment; time: number; messageId?: string } | undefined
  >(
    new URLSearchParams(location.search).has("photo")
      ? { attachment: photo, time: 0 }
      : new URLSearchParams(location.search).has("review")
        ? { attachment, time: 0 }
        : undefined,
  );
  const trigger = useRef<HTMLElement | null>(null);
  if (new URLSearchParams(location.search).has("tall-image"))
    return (
      <div style={{ width: "fit-content", maxWidth: "100%" }}>
        {new URLSearchParams(location.search).has("image-thread") ? (
          <MediaAttachment
            attachment={{
              kind: "image",
              url: "https://user-images.githubusercontent.com/fixture/tall.png",
            }}
            media={(source) => source}
            mode="thread"
            imageDescription="Tall screenshot"
          />
        ) : (
          <GitHubBody
            url="https://github.com/block/buzz-app/pull/1473"
            body="![Tall screenshot](https://user-images.githubusercontent.com/fixture/tall.png)"
          />
        )}
      </div>
    );

  return (
    <main style={{ maxWidth: 900, padding: "80px 40px", margin: "0 auto" }}>
      <p
        style={{ color: "var(--text-subtle)", fontSize: 12, marginBottom: 12 }}
      >
        BUZZ · MEDIA REVIEW
      </p>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Video and photo review</h1>
      <p style={{ color: "var(--text-subtle)", marginBottom: 32 }}>
        Expand the video or open a photo to review it. Comments and emoji
        reactions here are local to this preview.
      </p>
      {new URLSearchParams(location.search).has("thread") ? (
        <div style={{ height: 650 }}>
          <ThreadPanel
            session={session}
            extensions={extensions}
            scope="video-preview"
            channelId="video-preview"
            channelName="Video preview"
            messageId={rootMessage.id}
            close={() => {}}
            onOpenLink={() => false}
            onOpenMediaReview={(messageId, attachment, time) => {
              trigger.current = document.activeElement as HTMLElement;
              setReview({ messageId, attachment, time });
            }}
          />
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "start",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <MediaAttachment
            attachment={attachment}
            media={owner.session.media}
            onOpenReview={(selected, time) => {
              trigger.current = document.activeElement as HTMLElement;
              setReview({ attachment: selected, time });
            }}
          />
          {photos.map((item) => (
            <AttachmentImage
              key={item.url}
              attachment={item}
              url={item.url}
              source={owner.session.media(item.url)}
              onOpenLink={() => false}
              onOpenReview={(selected, time) => {
                trigger.current = document.activeElement as HTMLElement;
                setReview({ attachment: selected, time });
              }}
            />
          ))}
        </div>
      )}
      {review !== undefined && (
        // As the app's conversation does: a recorded working step replaces the
        // conversation indicator instead of repeating it.
        <ActivityIndicatorPresentation>
          <MediaReviewViewer
            attachment={review.attachment}
            session={session}
            extensions={extensions}
            scope="video-preview"
            channelId="video-preview"
            channelName="Video preview"
            messageId={review.messageId ?? rootMessage.id}
            initialTime={review.time}
            hasComments={!emptyThread}
            restoreFocus={trigger}
            onOpenLink={() => false}
            close={() => setReview(undefined)}
          />
        </ActivityIndicatorPresentation>
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);

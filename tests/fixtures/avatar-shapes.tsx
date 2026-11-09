import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Real avatar consumers with local display-only data, no session/broker/network reads.
import "../../src/shared/styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { Avatar as LegacyAvatar } from "../../src/shared/Avatar";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { MembershipRow } from "../../src/features/messages/MembershipRow";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import artwork from "./design-system/assets/avatar.png";

const agent = "a".repeat(64),
  human = "b".repeat(64);
// Flat color lets the paint test distinguish clipping from photo texture. The
// shared sanitiser only passes `https:` pictures to `media`, so profiles carry
// a remote URL and the fixture's `media` serves the inline artwork for it.
const insetPicture = "https://artwork.test/inset.svg";
const insetArtwork = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#ff00ff" d="M0 0h32v32H0z"/></svg>',
)}`;
const profiles = new Map([
  [agent, { name: "Agent", picture: insetPicture }],
  [human, { name: "Human", picture: insetPicture }],
]);
const agentPubkeys = new Set([agent]);
const row: ChannelMessage = {
  id: "message",
  authorId: agent,
  channelId: "fixture",
  createdAt: 1,
  content: "A message",
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [agent, human],
  replyCount: 2,
};
function Fixture() {
  useKeyboardFocusVisibility();
  const [opened, setOpened] = useState(false);
  const [pictures, setPictures] = useState(true);
  const media = (url: string) =>
    pictures ? (url === insetPicture ? insetArtwork : url) : undefined;
  return (
    // Match the message panel's opaque surface so clipped pixels have the same
    // backdrop as the overlap border in either theme, not the document canvas.
    <main style={{ padding: 24, background: "var(--surface)" }}>
      <button type="button">Before avatars</button>
      <section
        aria-label="System avatars"
        style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBlock: 24 }}
      >
        {(["small", "default", "large", "fill"] as const).flatMap((size) =>
          (["circle", "squircle"] as const).map((shape) => (
            <div
              key={`${size}-${shape}`}
              style={size === "fill" ? { width: 128, height: 128 } : undefined}
            >
              <Avatar
                size={size}
                shape={shape}
                src={size === "small" ? undefined : artwork}
                alt={`${size} ${shape}`}
                fallback="Avatar"
              />
            </div>
          )),
        )}
      </section>
      <section
        aria-label="Legacy avatars"
        style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBlock: 24 }}
      >
        <LegacyAvatar
          name="Human"
          src={artwork}
          shape="circle"
          className="size-7 rounded-lg"
        />
        <LegacyAvatar
          name="Agent"
          src={artwork}
          shape="squircle"
          className="size-7 rounded-lg"
        />
      </section>
      <MessageRow
        row={{ ...row, agentEnvelope: true }}
        profile={profiles.get(agent)}
        participantProfiles={profiles}
        agentPubkeys={agentPubkeys}
        media={media}
        canOpenLink={() => true}
        onOpenLink={() => {
          setOpened(true);
          return true;
        }}
        day={false}
        retry={undefined}
        onOpenThread={() => {}}
      />
      {[agent, human].map((target) => (
        <MembershipRow
          key={target}
          row={{
            ...row,
            id: `membership-${target}`,
            membership: {
              type: "member_joined",
              actor: target === agent ? human : agent,
              target,
            },
          }}
          profiles={profiles}
          agentPubkeys={agentPubkeys}
          media={media}
          day={false}
        />
      ))}
      <label>
        <input
          type="checkbox"
          checked={pictures}
          onChange={(event) => setPictures(event.currentTarget.checked)}
        />
        Show pictures
      </label>
      {opened && <p role="status">Profile opened</p>}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <ToastProvider>
    <Fixture />
  </ToastProvider>,
);

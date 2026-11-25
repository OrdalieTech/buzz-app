// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import { flush } from "../../features/relay/testing";
import { SpeechService } from "../../features/speech/service";
import {
  createNativeSession,
  followCommunity,
  type Credential,
} from "./session";
import {
  builderlabSpeechProvider,
  nativeBuilderlabSpeech,
  offerBuilderlabSpeech,
  type BuilderlabSpeechConnect,
} from "./speech";
import { createTestSession } from "./test-helpers";

const credential = (revision: string, transcription = true): Credential => ({
  revision,
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: true,
    canUseHostedTranscription: transcription,
  },
});
const request = {
  offer: "v=0 offer",
  community: "wss://relay.example.org",
  timeoutMs: 20_000,
};
const signal = new AbortController().signal;
const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(async () => ({})),
}));
vi.mock("@tauri-apps/api/core", () => tauri);
afterEach(() => tauri.isTauri.mockReturnValue(false));

it("names the native session by its revision, never a token", async () => {
  tauri.isTauri.mockReturnValue(true);
  await nativeBuilderlabSpeech()?.(request, credential("fi-revision"));
  expect(tauri.invoke).toHaveBeenLastCalledWith("speech_connect", {
    provider: "builderlab",
    request,
    federated: "fi-revision",
  });
});

it("needs a sign-in, then sends the offer with it", async () => {
  const session = createTestSession(async () => credential("first"));
  const native = vi.fn<BuilderlabSpeechConnect>(async () => ({
    outcome: "answered",
    sdp: "v=0 answer",
  }));
  const provider = builderlabSpeechProvider(session, true, native);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.connect(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "missing_credentials",
  });
  expect(native).not.toHaveBeenCalled();
  await session.signIn();
  expect(provider.status()).toBe("ready");
  await expect(provider.connect(request, { signal })).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
  });
  expect(native).toHaveBeenCalledWith(request, session.credential());
});

it("sends a requested call length and returns the cap Builderlab granted", async () => {
  const session = createTestSession(async () => credential("first"));
  const native = vi.fn<BuilderlabSpeechConnect>(async () => ({
    outcome: "answered",
    sdp: "v=0 answer",
    max_seconds: 900,
  }));
  const provider = builderlabSpeechProvider(session, true, native);
  await session.signIn();
  const long = { ...request, maxSeconds: 3_600 };
  await expect(provider.connect(long, { signal })).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
    maxSeconds: 900,
  });
  expect(native).toHaveBeenCalledWith(long, session.credential());

  native.mockResolvedValueOnce({
    outcome: "answered",
    sdp: "v=0 answer",
    max_seconds: "900",
  });
  await expect(provider.connect(request, { signal })).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
  });
});

it("sends nothing unless the account may use transcription", async () => {
  const session = createTestSession(async () => credential("first", false));
  const native = vi.fn<BuilderlabSpeechConnect>();
  const provider = builderlabSpeechProvider(session, true, native);
  await session.signIn();
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.connect(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(native).not.toHaveBeenCalled();
});

it("passes native failures through and refuses unknown replies", async () => {
  const session = createTestSession(async () => credential("first"));
  const native = vi.fn<BuilderlabSpeechConnect>();
  const provider = builderlabSpeechProvider(session, true, native);
  await session.signIn();
  const replies: unknown[] = [
    { outcome: "failed", reason: "rate_limited" },
    { outcome: "failed", reason: "made_up" },
    { outcome: "answered" },
    null,
  ];
  const reasons = [];
  for (const reply of replies) {
    native.mockResolvedValueOnce(reply);
    reasons.push(await provider.connect(request, { signal }));
  }
  native.mockRejectedValueOnce(new Error("boom"));
  reasons.push(await provider.connect(request, { signal }));
  expect(reasons.map((reply) => "reason" in reply && reply.reason)).toEqual([
    "rate_limited",
    "invalid_response",
    "invalid_response",
    "invalid_response",
    "service_error",
  ]);
});

it("is never offered outside the desktop app", async () => {
  const session = createTestSession(async () => credential("first"));
  const provider = builderlabSpeechProvider(session, true, undefined);
  await session.signIn();
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.connect(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unavailable",
  });
});

it("offers Builderlab while signed in, and listens with it while the account may", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const speech = new SpeechService(root, undefined);
  let allowed = false;
  const session = createTestSession(async () => credential("first", allowed));
  const offer = (native: BuilderlabSpeechConnect | undefined) =>
    root
      .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
      .plugin((ctx) => offerBuilderlabSpeech(ctx, session, true, native));
  const fiber = offer(vi.fn<BuilderlabSpeechConnect>());
  await fiber.await();
  await flush();
  const keys = () => speech.providers().map((provider) => provider.key);
  expect(keys()).toEqual([]);
  expect(speech.status()).toBe("unavailable");
  await session.signIn();
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  // Signed in without access: Builderlab needs setup, and nothing listens.
  expect(speech.backend()).toBe("block.builderlab/builderlab");
  expect(speech.status()).toBe("needs-setup");
  session.signOut();
  allowed = true;
  await session.signIn();
  expect(speech.status()).toBe("ready");
  session.signOut();
  expect(keys()).toEqual([]);
  expect(speech.status()).toBe("unavailable");
  await session.signIn();
  await fiber.dispose();
  expect(keys()).toEqual([]);
  const browser = offer(undefined);
  await browser.await();
  await flush();
  expect(keys()).toEqual([]);
});

it("listens with the sign-in of the community in view, a Builderlab customer's own", async () => {
  const build = federatedFixture("build");
  const peer = federatedFixture("peer");
  const authority = peer.service.snapshot().authority;
  if (!authority) throw new Error("Missing fixture authority");
  peer.publish({
    authority: {
      ...authority,
      id: "bb-block",
      identityOrigin: "https://block.example",
      apiBasePath: "/api/goose/",
    },
  });
  const identity = {
    ...build.service,
    forCommunity: (origin: string) =>
      origin === "wss://buzz.block.example" ? peer.service : build.service,
  };
  const relay = {
    snapshot: () => ({}),
    selected: () => "wss://buzz.block.example",
    subscribe: () => () => {},
  };
  const account = (subject: string, transcription: boolean) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      subject,
      capabilities: { can_use_hosted_transcription: transcription },
    }),
  });
  // The build's server (bb-public) offers no hosted speech; the community's does.
  build.request.mockImplementation(async ({ relay: named }) =>
    account(named ? "block" : "public", !!named),
  );
  build.publish({ status: "signed-in", revision: "build:1" });
  peer.publish({ status: "signed-in", revision: "peer:1" });
  const session = createNativeSession(identity);
  const community = followCommunity(session, identity, relay);
  const native = vi.fn<BuilderlabSpeechConnect>(async () => ({
    outcome: "answered",
    sdp: "v=0 answer",
  }));
  const provider = builderlabSpeechProvider(community, true, native);
  await expect.poll(() => provider.status()).toBe("ready");
  const call = { ...request, community: "wss://buzz.block.example" };
  await expect(provider.connect(call, { signal })).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
  });
  expect(native).toHaveBeenCalledWith(
    call,
    expect.objectContaining({ revision: "peer:1" }),
  );
  community.dispose();
  session.dispose();
});

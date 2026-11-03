import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import {
  bundledHost,
  firstRunCredential,
} from "../../bundled/builderlab/oauth/first-run";
import { createOAuthSession } from "../../bundled/builderlab/oauth/session";
import { communityDestination } from "../communities/destination";
import { FindCommunity, type JoinConsent } from "../communities/FindCommunity";
import type { FoundCommunity } from "../communities/find-community";
import type { createInviteIntent } from "../communities/invite-intent";
import {
  type Admission,
  admitCommunity,
  CLAIM_REFUSALS,
  completeJoin,
  type Current,
} from "../communities/join";
import { createJoinJournal, JournalError } from "../communities/join-journal";
import type { Communities, PersonalProfile } from "../communities/service";
import { readErrorKind } from "../relay/errors";
import { Button } from "../../shared/design-system/ui/Button";
import { BackupOffer } from "./BackupOffer";
import { hostedByThisBuilderlab } from "./builderlab-hosted";
import {
  builderlabAccount,
  type FirstRunAccount,
  type OwnedCommunity,
  seededAccount,
} from "./builderlab-account";
import { CommunityUrlField } from "./CommunityUrlField";
import { ConnectChoice } from "./ConnectChoice";
import { InviteCodeField } from "./InviteCodeField";
import styles from "./IdentitySetup.module.css";
import { parseFirstRunAccountSeed } from "./first-run-seed";
import { JoinCommunity } from "./JoinCommunity";
import { KeyChoice } from "./KeyChoice";
import { KeyImport } from "./KeyImport";
import { KeyLost } from "./KeyLost";
import { KeyRestore } from "./KeyRestore";
import { useLegacyIdentityOffer } from "./LegacyIdentityOffer";
import { OnboardingScreen } from "./OnboardingScreen";
import { OnboardingWordmark } from "./OnboardingWordmark";
import { ProfileStep } from "./ProfileStep";
import { PublicKeyPanel } from "./PublicKeyPanel";
import type { Restored } from "./restore-communities";
import { type Identity, nativeIdentityEnabled } from "./service";
import {
  backUp,
  checkAccount,
  checkBackup,
  createKey,
  createSetup,
  findCommunities,
  importKey,
  linkKey,
  type Resting,
  restoreCommunities,
  type SetupPause,
  unlinkKey,
} from "./setup";
import { SetupProgress } from "./SetupProgress";
import { WelcomeBack } from "./WelcomeBack";
import { WireframeScreen } from "./Wireframe";

/**
 * The signed-in account: the development seed when a dev server set one
 * (production builds define it empty), else the build URL's kgoose through
 * the same bundled grant the sign-in used, and the identity's native uploader.
 */
const firstRunAccount = (credential: Credential, identity: Identity) => {
  const seed = parseFirstRunAccountSeed(
    import.meta.env.VITE_BUZZ_FIRST_RUN_ACCOUNT,
  );
  return seed
    ? seededAccount(seed, identity)
    : builderlabAccount(credential, bundledHost.request, identity);
};

/**
 * First-launch gate: renders children once a human key exists on this device,
 * except while first-run setup is in progress, which creates that key midway.
 */
export function Welcome({
  identity,
  communities,
  invites,
  children,
  connect = firstRunCredential,
  account = firstRunAccount,
}: {
  identity: Identity;
  /** The live startup service: joining through it is what selects the community. */
  communities: Pick<Communities, "snapshot" | "joined" | "select">;
  /**
   * The app's invite intent: a typed address the restore did not admit is
   * handed to the rail's Add-a-community dialog as the gate lifts.
   */
  invites: Pick<ReturnType<typeof createInviteIntent>, "open">;
  children: ReactNode;
  connect?: (signal: AbortSignal) => Promise<Credential>;
  /** The account for a credential `connect` returned. */
  account?:
    | ((credential: Credential, identity: Identity) => FirstRunAccount)
    | undefined;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [login] = useState(() => createOAuthSession(connect));
  // Counts canceled sign-ins: a sign-in continues only if none was canceled
  // since it started, since the session may by then hold a later sign-in.
  const cancels = useRef(0);
  const auth = useSyncExternalStore(login.subscribe, login.snapshot);
  const [setup] = useState(createSetup);
  const progress = useSyncExternalStore(setup.subscribe, setup.snapshot);
  // The signed-in account's reads, from sign-in until the landing is shown again.
  const reads = useRef<FirstRunAccount | undefined>(undefined);
  // The hex key the account check found bound to the account: the returning-
  // user lane. Cleared by Start over and on the landing.
  const [linked, setLinked] = useState<string>();
  // The communities that key owns; `undefined` until found, or when the list failed.
  const [owned, setOwned] = useState<readonly OwnedCommunity[]>();
  // The destinations saved to the account, read with the account check and
  // restored as every lane ends; `undefined` until read, or when the list
  // failed. The account's, not a key's, so it lives as long as `reads`: Start
  // over keeps it and the landing clears it.
  const known = useRef<readonly string[] | undefined>(undefined);
  // The keys the account holds a backup of; `undefined` until listed, or when
  // backup status is unavailable or failed. Cleared on the landing.
  const [backups, setBackups] = useState<readonly string[]>();
  // The typed address survives a round trip to the find page and back.
  const [entered, setEntered] = useState("");
  // The canonical origin the user asked to join: before sign-in it drives the
  // discovery lookup; after setup, the Join Community page. Cleared on every
  // return to the landing or choices page.
  const [finding, setFinding] = useState<string>();
  // The code of the invite link `finding` came from, claimed on Join; "" for
  // a bare address. Every submit sets it with `finding`.
  const [inviteCode, setInviteCode] = useState("");
  const [joinError, setJoinError] = useState<{
    title: string;
    error: string;
    /** Set when the relay refused the key: the page takes a code and offers Try again. */
    denied?: Denied;
    /** Why the relay refused the code the join claimed. */
    codeError?: string | undefined;
  }>();
  const [retrying, setRetrying] = useState<"read" | "code">();
  // Set for a user with no profile yet once the relay admits the key; the
  // gate lifts when it exits.
  const [profileStep, setProfileStep] = useState<ProfileStepState>();
  const viewer = state.status === "ready" ? state.viewer : undefined;
  // The join owner's recovery record, as the Add-a-community dialog keeps it:
  // a relaunch resumes an unfinished join from there, through that dialog.
  const journal = useMemo(
    () =>
      nativeIdentityEnabled() && viewer ? createJoinJournal(viewer) : undefined,
    [viewer],
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** The owner's fence: still shown, and `entry` still the journal's record. */
  const current: Current = (entry) =>
    mounted.current && (!entry || !journal || journal.current(entry));
  // The typed address the restore entered the app without; opened in the
  // join dialog, with its invite code, once the gate lifts.
  const handoff = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      if (login.snapshot().status === "pending") login.cancel();
    },
    [login],
  );
  const discovering = finding && auth.status === "signed-out";
  /**
   * The page rendered below, keyed in the order the JSX decides it, so a
   * change of key is a page replacing another; `undefined` while nothing of
   * the user's is shown — the gate lifted, or the key still being restored —
   * so launch never moves focus.
   */
  const page =
    state.status === "loading"
      ? undefined
      : state.status === "error"
        ? "error"
        : progress.status === "idle"
          ? state.status === "ready"
            ? undefined
            : auth.error
              ? "auth-error"
              : discovering
                ? "discover"
                : "landing"
          : progress.status === "done"
            ? profileStep
              ? "done:profile"
              : joinError
                ? `done:join-error:${joinError.title}`
                : finding
                  ? "done:find"
                  : "done:join"
            : progress.status === "paused"
              ? `paused:${progress.at}`
              : progress.status;
  // A page replacing another takes focus with it: Back returns it to the
  // choice that opened the page it leaves (`data-return-focus`); otherwise
  // the new heading has it — unless the page focused a field itself, which
  // this passive effect runs after, as the app's own fill-in does.
  const shown = useRef<string | undefined>(undefined);
  const returnFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      shown.current !== undefined &&
      page !== undefined &&
      shown.current !== page
    ) {
      const trigger = returnFocus.current
        ? document.querySelector<HTMLElement>(
            `[data-return-focus="${returnFocus.current}"]`,
          )
        : null;
      if (trigger) trigger.focus();
      else if (document.activeElement === document.body)
        document
          .getElementById("welcome-title")
          ?.focus({ preventScroll: true });
    }
    returnFocus.current = undefined;
    shown.current = page;
  }, [page]);
  const legacyOffer = useLegacyIdentityOffer(
    identity,
    page === "landing" && auth.status !== "pending",
  );
  if (state.status === "ready" && progress.status === "idle") return children;
  // The linked key is backed up: Welcome back offers a restore, and an
  // import of it skips the backup offer.
  const backedUp = !!linked && !!backups?.includes(linked);
  /**
   * Sign-in leads to the account check, which picks the lane: a linked key
   * pauses on Welcome back, otherwise the key choice. The backed-up-key
   * lookup runs on both. Each choice below resumes setup with its own steps.
   */
  const signIn = async () => {
    const attempt = cancels.current;
    // A canceled attempt still settles here, possibly after a later sign-in
    // succeeded; it must not read that one's credential.
    await login.signIn();
    if (attempt !== cancels.current || login.snapshot().status !== "signed-in")
      return;
    const current = account(login.credential(), identity);
    reads.current = current;
    void setup.start(
      [
        checkAccount(current, setLinked, (list) => {
          known.current = list;
        }),
        checkBackup(current, setBackups),
      ],
      { status: "paused", at: "key-choice" },
    );
  };
  /** Between pauses nothing runs: no key exists until a choice resumes setup. */
  const pause = (at: SetupPause) =>
    void setup.start([], { status: "paused", at });
  /** A page's Back: the choice that opened it, marked `data-return-focus`, takes focus again. */
  const back = (to: SetupPause, trigger: "import" | "restore" | "lost") => {
    returnFocus.current = trigger;
    pause(to);
  };
  /**
   * The lifted gate takes over: a pending handoff opens the join dialog for
   * the typed address, and nothing kept here can show discovery for it again.
   * The reset is ignored while the restore runs; it rests idle instead.
   */
  const enterApp = () => {
    const current = identity.snapshot();
    if (handoff.current && current.status === "ready")
      invites.open(
        { community: handoff.current, code: inviteCode },
        current.viewer,
      );
    handoff.current = undefined;
    setFinding(undefined);
    setInviteCode("");
    setEntered("");
    setup.reset();
  };
  /**
   * Where the restore rests. With nothing admitted, setup ends on the Join
   * page as before. Otherwise it selects the typed address when that was
   * admitted, else the first admitted, and enters the app (after the profile
   * step when no profile exists yet), handing a typed address it did not
   * admit to the join dialog.
   */
  const decide = (outcomes: readonly Restored[]): Resting | undefined => {
    const admitted = outcomes.filter((outcome) => outcome.kind === "admitted");
    const typed = finding ? communityDestination(finding).id : undefined;
    const chosen =
      admitted.find((outcome) => outcome.id === typed) ?? admitted[0];
    if (!chosen?.read) return undefined;
    communities.select(chosen.id);
    handoff.current = chosen.id === typed ? undefined : finding;
    // `joined` adopts a relay profile only into an empty local default, so
    // with no relay profile read the local one is unchanged by the restore.
    if (
      !admitted.some((outcome) => outcome.read?.exists) &&
      !communities.snapshot().profile.name
    ) {
      setProfileStep({ found: chosen, read: chosen.read });
      return undefined;
    }
    enterApp();
    return { status: "idle" };
  };
  /** Restores the account's saved destinations, when it has any. */
  const restore = () =>
    known.current?.length
      ? [restoreCommunities(known.current, communities, decide)]
      : [];
  /** How every lane ends: a linked account's owned communities feed Join a community. */
  const finish = () => [
    ...(linked && reads.current
      ? [findCommunities(reads.current, setOwned)]
      : []),
    ...restore(),
  ];
  /** A submitted address or invite link: what to look up, and the code to claim. */
  const find = (origin: string, code = "") => {
    setFinding(origin);
    setInviteCode(code);
  };
  /** Every way back to the landing, so a kept `finding` cannot re-enter discovery. */
  const backToLanding = () => {
    setFinding(undefined);
    setInviteCode("");
    setLinked(undefined);
    setOwned(undefined);
    setBackups(undefined);
    reads.current = undefined;
    known.current = undefined;
    setup.reset();
    cancels.current++;
    login.cancel();
  };
  /**
   * The Add-a-community dialog's completion for the community the step
   * holds (`src/features/communities/join.ts`): with `publish`, the draft is
   * journaled, the profile read afresh, published when it differs and read
   * back; then the membership is saved through the live Communities service —
   * after the profile step, when there was one — which selects it, and the
   * journal's record for the destination is cleared. A restored community is
   * already saved: `joined` takes the same id again and adopts the profile
   * into the empty local default. `false` means the fence stopped it.
   */
  const complete = (step: ProfileStepState, publish?: PersonalProfile) =>
    completeJoin({
      community: step.found.url,
      membership: {
        id: step.found.url,
        name: step.found.host,
        ...(step.found.icon ? { icon: step.found.icon } : {}),
      },
      found: step.read,
      journal,
      // The journal's current record, whichever step wrote it last: a failed
      // publish replaced the admission's.
      entry: journal?.get(step.found.url),
      publish,
      communities,
      current,
    });
  const leave = () => {
    setProfileStep(undefined);
    enterApp();
  };
  /**
   * How a join ends: completed, then — for a join, not a restore — saved to
   * the account, so another device restores it (`joined` queued the same
   * idempotent add for the next Settings sign-in; best effort: `call` warns
   * of a refused answer in development, and a failure never stops entry), and
   * the gate lifts into the app on that community.
   */
  const finishJoin = async (
    step: ProfileStepState,
    publish?: PersonalProfile,
  ) => {
    if (!(await complete(step, publish))) return;
    if (step.admission)
      await reads.current?.saveCommunity(step.found.url).catch(() => {});
    leave();
  };
  /**
   * The same join the Add-a-community dialog performs, through its owner:
   * the join is journaled before any remote effect (so a relaunch resumes it
   * through the dialog, and a lost claim reply is never claimed again), an
   * invite code, when there is one, is claimed first, and a signed profile
   * read proves admission. The membership is saved by `finishJoin`: at once,
   * or after the profile step a user with no profile yet continues to. The
   * join itself publishes nothing.
   */
  const join = async (
    found: FoundCommunity,
    consent: JoinConsent,
    code: string,
  ) => {
    const fail = (error: string, title = "Couldn’t join community") =>
      setJoinError({ title, error });
    const unreachable = () =>
      fail("Could not reach the relay. Check your connection and try again.");
    const client = communities.snapshot();
    if (client.status !== "ready")
      return fail(client.error ?? "Your saved communities aren’t ready yet.");
    const needsInvite = (codeError?: string) =>
      setJoinError({
        title: "This community needs an invite",
        error: `${found.host} admits members by invite, and this key has none yet. Enter an invite code, or send your public key to a community administrator so they can add you, then try again.`,
        denied: { found, consent },
        codeError,
      });
    let admission: Admission | undefined;
    try {
      admission = await admitCommunity({
        community: found.url,
        journal,
        code,
        policy: found.policy,
        consent,
        current,
      });
    } catch (error) {
      // A refused code (already its copy, from the owner; "Invalid invite
      // code" is the native route's for one it will not send) is the user's
      // to replace on the invite page; a relay that refuses the key needs one;
      // the journal's own storage message is shown as is. Everything else is
      // classified, not echoed.
      const refusal =
        error instanceof Error
          ? (Object.values(CLAIM_REFUSALS).find(
              (copy) => copy === error.message,
            ) ??
            (error.message === "Invalid invite code"
              ? CLAIM_REFUSALS.invite_invalid
              : undefined))
          : undefined;
      if (refusal) return needsInvite(refusal);
      if (readErrorKind(error) === "denied") return needsInvite();
      return error instanceof JournalError
        ? fail(error.message)
        : unreachable();
    }
    if (!admission) return;
    const step = { found, read: admission.found, admission };
    // Neither the relay nor the local default (read before `joined` may adopt
    // the relay's) holds a profile: the profile step asks for one, and the
    // membership waits for it.
    if (!admission.found.exists && !client.profile.name)
      return setProfileStep(step);
    try {
      await finishJoin(step);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
  /** Try again repeats the read; a typed code is claimed first. */
  const retry = async ({ found, consent }: Denied, code = "") => {
    setRetrying(code ? "code" : "read");
    try {
      await join(found, consent, code);
    } finally {
      setRetrying(undefined);
    }
  };
  const denied = joinError?.denied;
  // A failure once a key is saved. A failed link (or the unlink before it)
  // blocks: nothing links the key later, so letting the user past it would
  // leave the key on this device only, and the page offers the error and Try
  // again until Builderlab answers. A failed backup may be skipped: a later
  // sign-in runs the backup again.
  const failedAfterKey =
    progress.status === "failed" && state.status === "ready";
  const blocked = failedAfterKey && progress.skipsLink;
  const skipped = failedAfterKey && !blocked ? SKIPPED_BACKUP : undefined;
  /**
   * The pages setup rests on. The first two may be reached before any sign-in,
   * for a found community; the rest only after one. A pause this
   * component did not reach has nothing to render.
   */
  const paused = (at: SetupPause) => {
    const current = reads.current;
    switch (at) {
      case "connect-choice":
        // Connect is the landing's own sign-in: resetting first lets the
        // landing show it pending, with Cancel sign-in.
        return finding ? (
          <ConnectChoice
            host={new URL(finding).host}
            onConnect={() => {
              setup.reset();
              void signIn();
            }}
            onImport={() => pause("key-import")}
            onBack={backToLanding}
          />
        ) : null;
      case "key-import":
        // With no account this run (the connect choice), the key is nobody's
        // to link or back up, so the import is the whole setup. On the linked
        // lane only the linked key is accepted, so there is nothing to link.
        // Otherwise an imported key is linked like a created one. Either way
        // the backup is offered, never assumed: the key may be used elsewhere.
        // The linked lane skips the offer when status already lists the key.
        return (
          <KeyImport
            expectedPubkey={linked}
            onBack={() =>
              back(
                !current
                  ? "connect-choice"
                  : linked
                    ? "welcome-back"
                    : "key-choice",
                "import",
              )
            }
            onImport={async (nsec) => {
              await importKey(identity, nsec);
              if (!current) void setup.start([]);
              else if (!linked)
                void setup.start([linkKey(identity, current)], {
                  status: "paused",
                  at: "backup-offer",
                });
              else if (!backedUp) pause("backup-offer");
              else void setup.start(finish());
            }}
          />
        );
    }
    if (!current) return null;
    // A new key becomes the account's before it is backed up.
    const link = linkKey(identity, current);
    const backUpKey = backUp(identity, current);
    switch (at) {
      case "key-choice":
        return (
          <KeyChoice
            email={auth.account?.email}
            backups={backups}
            onCreate={() =>
              void setup.start([
                createKey(identity),
                link,
                backUpKey,
                ...finish(),
              ])
            }
            onImport={() => pause("key-import")}
            onSwitchAccount={backToLanding}
          />
        );
      case "welcome-back":
        return linked ? (
          <WelcomeBack
            npub={npubEncode(linked)}
            email={auth.account?.email}
            onRestore={
              backedUp
                ? () => {
                    void current.recovery.beginRecovery();
                    pause("key-restore");
                  }
                : undefined
            }
            onImport={() => pause("key-import")}
            onLost={() =>
              void setup.start([findCommunities(current, setOwned)], {
                status: "paused",
                at: "key-lost",
              })
            }
            onSwitchAccount={backToLanding}
          />
        ) : null;
      case "key-restore":
        // A restored key is already backed up, so no backup step follows.
        return linked ? (
          <KeyRestore
            recovery={current.recovery}
            expectedPubkey={linked}
            onBack={() => back("welcome-back", "restore")}
            onImport={() => pause("key-import")}
            onInstalled={() => {
              if (identity.snapshot().status === "ready")
                void setup.start(finish());
            }}
          />
        ) : null;
      case "backup-offer":
        return (
          <BackupOffer
            onSkip={() => void setup.start(finish())}
            onBackUp={() => void setup.start([backUpKey, ...finish()])}
          />
        );
      case "key-lost":
        // Starting over creates a new key, as Create my key does, and the old
        // key's communities are not offered to it (so the lane ends with the
        // restore alone, not `finish`). The old key stays linked
        // until the new one exists, so the account is never left without a
        // key; binding never overwrites, so the old one is unlinked before the
        // new one is linked.
        return linked ? (
          <KeyLost
            owned={owned}
            onBack={() => back("welcome-back", "lost")}
            onStartOver={() => {
              setLinked(undefined);
              setOwned(undefined);
              void setup.start([
                createKey(identity),
                unlinkKey(identity, current, linked),
                link,
                backUpKey,
                ...restore(),
              ]);
            }}
          />
        ) : null;
    }
  };
  if (state.status === "loading" || state.status === "error")
    return (
      <OnboardingScreen
        labelledBy="welcome-title"
        intro={
          // The frame already centres and pads this column: no `.setup` wrapper.
          <div className={`${styles.setupContent} w-full max-w-md`}>
            <h1
              id="welcome-title"
              tabIndex={-1}
              className="text-heading text-standard"
            >
              Your Buzz identity
            </h1>
            {state.status === "loading" ? (
              <p role="status">Opening your saved identity…</p>
            ) : (
              <>
                <p role="alert">{state.error}</p>
                <Button onClick={() => void identity.retry()}>
                  Retry secure storage access
                </Button>
              </>
            )}
          </div>
        }
      >
        {null}
      </OnboardingScreen>
    );
  // Discovery: the same unauthenticated lookup Join Community runs after
  // setup, so a bad address fails here, before sign-in and before a key
  // exists. A community hosted by this build's Builderlab signs in at once;
  // any other asks the user whether to connect at the build portal or bring
  // a key.
  if (progress.status === "idle" && !auth.error && !discovering)
    return (
      <OnboardingScreen
        labelledBy="welcome-title"
        intro={
          <>
            <h1 id="welcome-title" tabIndex={-1} className={styles.wordmark}>
              <OnboardingWordmark />
            </h1>
            <p className={styles.tagline}>
              Your people, your agents, your projects —<br />
              all in one place.
            </p>
          </>
        }
      >
        <Button
          hidden={import.meta.env.VITE_BUZZ_BROWSER_HOST === "1"}
          variant={auth.status === "pending" ? "outline" : "prominent"}
          size="lg"
          onClick={() => {
            if (auth.status === "pending") backToLanding();
            else void signIn();
          }}
        >
          {auth.status === "pending" ? "Cancel sign-in" : "Sign in with email"}
        </Button>
        {auth.status === "pending" && (
          <p role="status" className="text-body-sm text-subtle">
            Finish sign-in in your browser, then return to Buzz.
          </p>
        )}
        {/* The action column centres its text; the field keeps its label aligned. */}
        <div className="text-left">
          <CommunityUrlField
            url={entered}
            onUrlChange={setEntered}
            onSubmit={find}
            disabled={auth.status === "pending"}
          />
        </div>
        {legacyOffer}
      </OnboardingScreen>
    );
  // The key pages and Join a community bring their own onboarding layouts;
  // the rest are wireframes. A pause with nothing to render keeps the frame,
  // so the title bar and window controls stay.
  if (
    progress.status === "paused" &&
    ["key-choice", "key-import", "key-restore"].includes(progress.at)
  )
    return paused(progress.at) ?? <WireframeScreen>{null}</WireframeScreen>;
  if (progress.status === "done" && !profileStep && !joinError && !finding)
    return (
      <JoinCommunity
        url={entered}
        onUrlChange={setEntered}
        onFind={find}
        owned={owned}
      />
    );
  return (
    <WireframeScreen>
      {progress.status === "done" ? (
        profileStep ? (
          <ProfileStep
            found={profileStep.found}
            read={profileStep.read}
            defaultName={auth.account?.email.split("@")[0] ?? ""}
            onContinue={(next) => finishJoin(profileStep, next)}
            // A restored community is saved already: Skip only leaves.
            onSkip={() =>
              profileStep.admission
                ? finishJoin(profileStep)
                : Promise.resolve(leave())
            }
          />
        ) : joinError ? (
          // Back returns to the find page, which looks the community up again.
          <Failure
            title={joinError.title}
            error={joinError.error}
            onBack={() => setJoinError(undefined)}
            publicKey={denied ? npubOf(state) : undefined}
            invite={
              denied && {
                error: joinError.codeError,
                onSubmit: (code) => void retry(denied, code),
              }
            }
            onRetry={denied && (() => void retry(denied))}
            busy={retrying}
          />
        ) : finding ? (
          <FindCommunity
            url={finding}
            onCancel={() => setFinding(undefined)}
            onJoin={(found, consent) => join(found, consent, inviteCode)}
            titleId="welcome-title"
          />
        ) : null
      ) : progress.status === "running" ? (
        <SetupProgress label={progress.label} />
      ) : progress.status === "paused" ? (
        paused(progress.at)
      ) : progress.status === "failed" ? (
        // Once a key is saved, the way on is Join without the steps left:
        // `backToLanding` would reset to idle, and with identity ready the
        // gate would lift into the app with no community.
        <Failure
          title="Couldn’t finish setup"
          error={progress.error}
          note={blocked ? UNLINKED_NOTE : skipped?.note}
          backLabel={skipped?.label}
          onBack={
            blocked
              ? undefined
              : skipped
                ? () => void setup.start(finish())
                : backToLanding
          }
          onRetry={
            blocked || progress.retryable ? () => void setup.retry() : undefined
          }
        />
      ) : auth.error ? (
        <Failure
          title="Couldn’t sign in"
          error={auth.error}
          onBack={backToLanding}
        />
      ) : finding ? (
        <FindCommunity
          url={finding}
          onCancel={backToLanding}
          onFound={(found) => {
            if (hostedByThisBuilderlab(found)) void signIn();
            else pause("connect-choice");
          }}
          titleId="welcome-title"
        />
      ) : null}
    </WireframeScreen>
  );
}

/** The refused key and the consent its Join carried, for a retry or a code. */
type Denied = { found: FoundCommunity; consent: JoinConsent };

/** The community the profile step is for, and the read that admitted the key. */
type ProfileStepState = {
  found: Pick<FoundCommunity, "url" | "host" | "icon">;
  read: Admission["found"];
  /** The join's admission; absent for a restored community, whose membership is saved already. */
  admission?: Admission;
};

/**
 * Admins admit people by npub, so the denied page shows the key to send them.
 * Full npub only: the service validates the viewer as 64-hex, so encoding fails
 * only on a snapshot that is not ready, and no key block is shown then.
 */
function npubOf(state: ReturnType<Identity["snapshot"]>) {
  if (state.status !== "ready") return undefined;
  try {
    return npubEncode(state.viewer);
  } catch {
    return undefined;
  }
}

/**
 * What a failed link or unlink leaves undone: the key is not the account's
 * (and, after an unlink, the old key stays bound), and with it the backup,
 * which needs a linked key. The page has no way past it but Try again.
 */
const UNLINKED_NOTE =
  "Your key is saved on this device, but it isn’t linked to your account or backed up yet.";

/** The failed page's way on when only the backup is left undone. */
const SKIPPED_BACKUP = {
  label: "Continue without backup",
  note: "Your key is saved on this device, but it isn’t backed up yet.",
} as const;

function Failure({
  title,
  error,
  note,
  onBack,
  backLabel = "Back",
  publicKey,
  invite,
  onRetry,
  busy,
}: {
  title: string;
  error: string;
  /** Setup failed after the key was saved: say it is not lost, and what is undone. */
  note?: string | undefined;
  /** The way back or on; absent where the failure blocks and only Try again is offered. */
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  /** Shown as the user's shareable identity, with Copy, when set. */
  publicKey?: string | undefined;
  /** Offers an invite code field, with the last code's refusal under it. */
  invite?:
    | { error?: string | undefined; onSubmit: (code: string) => void }
    | undefined;
  /** Offers Try again; no action can start while `busy`. */
  onRetry?: (() => void) | undefined;
  /** Which action is in flight: Try again's read, or the code's claim. */
  busy?: "read" | "code" | undefined;
}) {
  return (
    <>
      <h1
        id="welcome-title"
        tabIndex={-1}
        className="text-heading text-standard"
      >
        {title}
      </h1>
      <p role="alert" className="text-body text-danger">
        {error}
      </p>
      {note && <p className="text-body text-subtle">{note}</p>}
      {invite && (
        <InviteCodeField
          error={invite.error}
          busy={!!busy}
          pending={busy === "code"}
          onSubmit={invite.onSubmit}
        />
      )}
      {publicKey && <PublicKeyPanel publicKey={publicKey} />}
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        {onBack && (
          <Button onClick={onBack} disabled={!!busy}>
            {backLabel}
          </Button>
        )}
        {onRetry && (
          // Loading keeps focus here, so a repeated denial, which leaves the
          // page unchanged, does not drop it.
          <Button
            variant="prominent"
            onClick={onRetry}
            loading={busy === "read"}
            disabled={busy === "code"}
          >
            Try again
          </Button>
        )}
      </div>
    </>
  );
}

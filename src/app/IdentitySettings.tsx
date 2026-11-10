import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { motion } from "motion/react";
import { npubEncode } from "nostr-tools/nip19";
import type {
  IdentityManagement,
  BackupStatus,
} from "../features/identity/backup";
import { BACKUP_FAILURES } from "../features/identity/backup-failure";
import { BackupPrompt } from "../features/identity/BackupConsent";
import {
  backedUpLinkedKey,
  backupOfferedFor,
  federatedBuilderlabAccount,
} from "../features/identity/builderlab-account";
import type { Identity } from "../features/identity/service";
import {
  signInServers,
  type FederatedIdentity,
  type SessionSnapshot,
} from "../features/federated-identity/service";
import type { Membership } from "../features/communities/service";
import {
  useSignInMemberships,
  serverName,
} from "../features/federated-identity/community-servers";
import { recoveryMessage } from "../features/federated-identity/CommunitySignIn";
import { SettingsSectionLink } from "../features/navigation/SettingsSectionLink";
import { PrivateKey } from "../features/identity/PrivateKey";
import { SignOutDialog } from "../features/identity/SignOut";
import { Header } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Button } from "../shared/design-system/ui/Button";
import {
  PopoverRoot,
  PopoverPopup,
  PopoverTrigger,
} from "../shared/design-system/ui/Popover";
import type { RelaySession } from "../features/relay/session";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import styles from "./IdentitySettings.module.css";
import { writeClipboardText } from "../shared/clipboard";
import { IdentityBadge } from "./IdentityBadge";
import { IdentityReflection } from "./IdentityReflection";
import { useIdentityTilt } from "./useIdentityTilt";
import { communityIcon } from "../features/communities/community-icon";
import { Avatar } from "../shared/design-system/ui/Avatar";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { SplitButton } from "../shared/design-system/ui/SplitButton";
import { MenuItem } from "../shared/design-system/ui/Menu";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { useProfileGeneration } from "../features/relay/react";
import { useAvatarPreview } from "../features/profiles/use-avatar-preview";
import { communityDestination } from "../features/communities/destination";
import { communityName } from "../features/communities/names";
import type { Profile } from "../features/relay/contracts";

const emptyProfiles = new Map<string, Profile>();
const emptyProfileSnapshot = () => emptyProfiles;
const emptySubscribe = () => () => {};
const emptySnapshot = () => undefined;

type BackedUp = { scope: object; attempt: number } & (
  | { key: string | null }
  | { failed: true }
);

/** Account lookup is independent of native backup health, but shares its recovery UI. */
function useBackedUpKey(
  viewer: string | undefined,
  identity: Identity | undefined,
  federated: FederatedIdentity | undefined,
  offered: boolean,
  backedUp: boolean,
) {
  const session = useSyncExternalStore(
    federated?.subscribe ?? emptySubscribe,
    federated?.snapshot ?? emptySnapshot,
  );
  const revision =
    offered && session?.status === "signed-in" && session.authority
      ? session.revision
      : undefined;
  const scope = useMemo(
    () => ({ viewer, identity, federated, revision }),
    [viewer, identity, federated, revision],
  );
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<BackedUp>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a finished backup reads the account again.
  useEffect(() => {
    if (!scope.revision || !scope.identity || !scope.federated || !scope.viewer)
      return;
    let current = true;
    const account = federatedBuilderlabAccount(
      { revision: scope.revision },
      scope.federated,
      scope.identity,
    );
    backedUpLinkedKey(account).then(
      (key) => {
        if (current) setRead({ scope, attempt, key });
      },
      () => {
        if (current) setRead({ scope, attempt, failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [scope, attempt, backedUp]);
  const shown = read?.scope === scope ? read : undefined;
  return {
    key: shown && "key" in shown ? shown.key : null,
    failed: !!shown && "failed" in shown,
    pending: !!revision && shown?.attempt !== attempt,
    refresh: useCallback(() => setAttempt((value) => value + 1), []),
  };
}

export function IdentitySettings({
  viewer,
  identity,
  federatedIdentity,
  servers = signInServers,
  builderlabIdentity,
  accountRows,
  openBuilderlab,
  profileSession,
  community,
  memberships = [],
}: {
  viewer?: string | undefined;
  identity?: Identity | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
  /** The build's sign-in servers; native's compiled list by default. */
  servers?: () => Promise<readonly SessionSnapshot[]>;
  /**
   * The same session as the Builderlab plugin's bundled installation, as
   * first run uses it: the host's own refuses authenticated requests.
   */
  builderlabIdentity?: FederatedIdentity | undefined;
  accountRows?: ReactNode;
  /** Opens Builderlab where its page holds the next backup step. */
  openBuilderlab?: (() => void) | undefined;
  profileSession?: RelaySession | undefined;
  community?: Membership | undefined;
  memberships?: readonly Membership[];
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (identity) void backupOfferedFor(identity.backup).then(setOffered);
  }, [identity]);
  const keyScope = useRef(viewer);
  const [policyError, setPolicyError] = useState(false);
  const status = useSyncExternalStore(
    identity?.backup.subscribe ?? emptySubscribe,
    identity?.backup.snapshot ?? emptySnapshot,
  );
  const candidate = status?.management;
  const management = candidate?.pubkey === viewer ? candidate : undefined;
  const checking = !!identity && !management;
  const managed = management?.policy === "organization-managed";
  const backupConfirmed =
    !!management &&
    (management.initialBackupConfirmed || status?.status === "complete");
  const accountBackup = useBackedUpKey(
    viewer,
    identity,
    builderlabIdentity,
    offered,
    status?.status === "complete",
  );
  const provider = useSyncExternalStore(
    federatedIdentity?.subscribe ?? emptySubscribe,
    federatedIdentity?.snapshot ?? emptySnapshot,
  );
  const backupLocation = provider?.authority
    ? serverName(provider.authority)
    : "Builderlab";
  useEffect(() => {
    if (keyScope.current !== viewer) setSigningOut(false);
    keyScope.current = viewer;
    setPolicyError(false);
    let current = true;
    void identity?.backup
      .ready()
      .then((next) =>
        next.management?.pubkey === viewer ? next : identity.backup.refresh(),
      )
      .then(
        (next) => {
          if (current && next.management?.pubkey !== viewer)
            setPolicyError(true);
        },
        () => {
          if (current) setPolicyError(true);
        },
      );
    return () => {
      current = false;
    };
  }, [identity, viewer]);
  const selectedProfileSession =
    profileSession?.viewer === viewer &&
    (!community ||
      profileSession?.scope ===
        `${communityDestination(community.id).url}:${viewer}`)
      ? profileSession
      : undefined;
  const profiles = useSyncExternalStore(
    selectedProfileSession?.profiles.subscribe ?? emptySubscribe,
    selectedProfileSession?.profiles.snapshot ?? emptyProfileSnapshot,
  );
  const profileGeneration = useProfileGeneration(
    selectedProfileSession?.profiles,
  );
  useEffect(() => {
    void profileGeneration;
    if (viewer && selectedProfileSession)
      void selectedProfileSession.profiles
        .ensure([viewer], "background")
        .catch(() => {});
  }, [viewer, selectedProfileSession, profileGeneration]);
  const profile =
    viewer && selectedProfileSession ? profiles.get(viewer) : undefined;
  const picture = useAvatarPreview(
    profile?.picture ?? "",
    community?.id,
    "small",
    selectedProfileSession?.media,
  );
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  const npub = viewer ? npubEncode(viewer) : "";
  async function copyIdentity(value: string, label: string) {
    const attempt = ++copyAttempt.current;
    setCopyStatus(null);
    try {
      await writeClipboardText(value);
      if (attempt === copyAttempt.current)
        setCopyStatus({ message: `${label} copied.`, failed: false });
    } catch {
      if (attempt === copyAttempt.current)
        setCopyStatus({
          message: `Couldn’t copy ${label.toLowerCase()}. Select it and copy manually.`,
          failed: true,
        });
    }
  }
  return (
    <section
      className={styles.identityLayout}
      aria-labelledby="identity-settings-title"
    >
      <Header
        id="identity-settings-title"
        title="Identity"
        subtitle="Your identity is shared across communities."
      />
      {!viewer && (
        <p>Your identity is unavailable. Connect your identity to manage it.</p>
      )}
      {viewer && (
        <>
          <div className={styles.overview}>
            <IdentityBadge
              key={viewer}
              viewer={viewer}
              name={
                profile && !profile.nameIsFallback
                  ? profile.name
                  : "Your Buzz ID"
              }
              picture={picture}
              photoContext={community ? communityName(community) : undefined}
              backup={
                !status?.builderlab
                  ? undefined
                  : !management
                    ? "pending"
                    : status.status === "running"
                      ? "running"
                      : status.status === "failed" || accountBackup.failed
                        ? "attention"
                        : backupConfirmed
                          ? "confirmed"
                          : managed
                            ? "attention"
                            : "pending"
              }
              backupLocation={backupLocation}
              onCopy={() => void copyIdentity(npub, "Buzz ID")}
            >
              {(active, badgeAction) => (
                <>
                  {identity && !signingOut ? (
                    <PrivateKey
                      key={active ? "active" : "hidden"}
                      identity={identity}
                      presentation="magnetic"
                    >
                      {({ input, warning, feedback }) => (
                        <>
                          <div
                            className={`dark interaction-panel ${styles.magneticKeyInput}`}
                          >
                            {input}
                          </div>
                          <div className={styles.keyNotice}>
                            <p className="text-label-sm">Your private key</p>
                            <p className="text-body-sm text-secondary">
                              This key is stored securely on this device.
                              {status?.builderlab &&
                                backupConfirmed &&
                                !accountBackup.failed && (
                                  <>
                                    {" "}
                                    A backup is saved with your {backupLocation}{" "}
                                    account.
                                  </>
                                )}
                            </p>
                            <p className="text-body-sm text-secondary">
                              Save a copy from the private key menu to use this
                              ID on another device. Lose every copy and you lose
                              this ID.
                            </p>
                            <div className={styles.keyWarning}>{warning}</div>
                            {feedback}
                          </div>
                        </>
                      )}
                    </PrivateKey>
                  ) : (
                    <>
                      <div>
                        <p className="text-label-sm">On this device</p>
                        <p className="text-body-sm text-secondary">
                          Your private key is kept in this device’s secure
                          storage. It proves this Buzz ID is yours.
                        </p>
                      </div>
                      <div>
                        <p className="text-label-sm">On a new device</p>
                        <p className="text-body-sm text-secondary">
                          Use a saved copy of your private key to restore this
                          ID. Keep it somewhere safe. If you lose every copy,
                          you can’t recover this ID.
                        </p>
                      </div>
                    </>
                  )}
                  {identity && (
                    <div className={styles.removeKey}>
                      {!signingOut && (
                        <BackupRecovery
                          viewer={viewer}
                          management={management}
                          status={status}
                          statusError={checking && policyError}
                          identity={identity}
                          offered={offered}
                          openBuilderlab={openBuilderlab}
                          accountError={accountBackup.failed}
                          accountPending={accountBackup.pending}
                          onStatusError={setPolicyError}
                          finalFocus={() => badgeAction.current}
                          onRetry={() => {
                            badgeAction.current?.focus({ preventScroll: true });
                            accountBackup.refresh();
                          }}
                        />
                      )}
                      <Button
                        variant="destructive"
                        onClick={() => setSigningOut(true)}
                      >
                        Remove from device
                      </Button>
                    </div>
                  )}
                </>
              )}
            </IdentityBadge>
            {federatedIdentity && (
              <div className={styles.accounts}>
                <Header
                  level={3}
                  title="Community sign-ins"
                  subtitle="Accounts you use to verify who you are and access your communities."
                />
                <OrganizationSignIns
                  identity={federatedIdentity}
                  servers={servers}
                  accountRows={accountRows}
                  memberships={memberships}
                />
              </div>
            )}
          </div>
          {copyStatus?.failed && (
            <p className="text-body-sm">
              Full Buzz ID:{" "}
              <code className={`text-mono ${styles.identityValue}`}>
                {npub}
              </code>
            </p>
          )}
          {identity && (
            <>
              {accountBackup.key && accountBackup.key !== viewer && (
                <SettingsGroup>
                  <PreferenceRow
                    title="Backed-up key · Linked"
                    subtitle={
                      <code className={`text-mono ${styles.identityValue}`}>
                        {npubEncode(accountBackup.key)}
                      </code>
                    }
                  />
                </SettingsGroup>
              )}
              {signingOut && (
                <SignOutDialog
                  identity={identity}
                  onClose={() => setSigningOut(false)}
                />
              )}
            </>
          )}
          {copyStatus && (
            <ToastNotice
              title={
                copyStatus.failed
                  ? "Identity wasn’t copied"
                  : copyStatus.message
              }
              {...(copyStatus.failed
                ? { description: copyStatus.message }
                : {})}
              tone={copyStatus.failed ? "error" : "success"}
              timeout={copyStatus.failed ? 0 : 5000}
              onDismiss={() => setCopyStatus(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Every server's session, live: one stable array until one changes. */
function useSessions(sessions: readonly FederatedIdentity[]) {
  const store = useMemo(() => {
    let cached: readonly SessionSnapshot[] = [];
    return {
      subscribe: (listener: () => void) => {
        const stops = sessions.map((session) => session.subscribe(listener));
        return () => {
          for (const stop of stops) stop();
        };
      },
      snapshot: () => {
        const next = sessions.map((session) => session.snapshot());
        if (
          next.length !== cached.length ||
          next.some((state, index) => state !== cached[index])
        )
          cached = next;
        return cached;
      },
    };
  }, [sessions]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** One row per configured provider, using each server's existing session controls. */
function OrganizationSignIns({
  identity,
  servers,
  accountRows,
  memberships,
}: {
  identity: FederatedIdentity;
  servers: () => Promise<readonly SessionSnapshot[]>;
  accountRows?: ReactNode;
  memberships: readonly Membership[];
}) {
  const [ids, setIds] = useState<readonly string[]>([]);
  useEffect(() => {
    let active = true;
    void servers()
      .then((list) => {
        if (active)
          setIds(list.flatMap((server) => server.authority?.id ?? []));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [servers]);
  const sessions = useMemo(
    () => ids.flatMap((id) => identity.forServer?.(id) ?? []),
    [identity, ids],
  );
  const states = useSessions(sessions);
  // Kept here, not in a row: a sign-out that fails still leaves signed-in,
  // so its row goes, and the failure must outlive it.
  const [failures, setFailures] = useState<
    ReadonlyMap<FederatedIdentity, SignOutFailure>
  >(new Map());
  const report = (session: FederatedIdentity, failure?: SignOutFailure) =>
    setFailures((current) => {
      const next = new Map(current);
      if (failure) next.set(session, failure);
      else next.delete(session);
      return next;
    });
  const signOut = (session: FederatedIdentity) => {
    const authority = session.snapshot().authority;
    if (!authority) return;
    report(session);
    void session.signOut().catch((error: unknown) =>
      report(session, {
        authority,
        failure: error instanceof Error ? error.message : "",
      }),
    );
  };
  // Native reports a sign-out it couldn't finish, such as a storage failure,
  // as that server's snapshot with `cleanup` rather than an error. Read from
  // the session, it survives Settings closing and a reload until cleanup ends.
  // Any other unavailable session, such as a failed restore, still has a
  // record that may be valid; signing out would delete it.
  const unfinished = new Map(failures);
  sessions.forEach((session, index) => {
    const state = states[index];
    if (state?.cleanup && state.authority)
      unfinished.set(session, {
        authority: state.authority,
        failure: state.failure ?? "",
      });
  });
  const problems = [...unfinished].map(([session, { authority, failure }]) => (
    <div key={authority.id}>
      <p role="alert" className="text-body-sm text-danger">
        {`Couldn’t sign out of ${serverName(authority)}. ${recoveryMessage(failure)}`}
      </p>
      <Button type="button" onClick={() => signOut(session)}>
        Try again
      </Button>
    </div>
  ));
  // The first server's own row would repeat its failure without naming it.
  const first = identity.snapshot().authority?.id;
  const firstFailed = [...unfinished.values()].some(
    ({ authority }) => authority.id === first,
  );
  const accountDetails = accountRows && (
    <div className={styles.accountEndnote}>{accountRows}</div>
  );
  if (sessions.length === 0)
    return (
      <>
        {!firstFailed ? (
          <OrganizationSignIn
            identity={identity}
            accountRows={accountRows}
            memberships={memberships}
          />
        ) : (
          accountDetails && (
            <div className={styles.accountList}>{accountDetails}</div>
          )
        )}
        {problems}
      </>
    );
  return (
    <section className={styles.accounts} aria-label="Accounts">
      <div className={styles.accountList}>
        {sessions.map((session, index) => {
          const state = states[index];
          if (
            !state?.authority ||
            (state.status !== "signed-in" && unfinished.has(session))
          )
            return null;
          const details = state.authority.id === first;
          return (
            <AccountCard
              key={state.authority.id}
              state={state}
              identity={session}
              memberships={memberships}
              endnote={details && state.status !== "restoring" && accountRows}
            >
              <OrganizationSignIn
                identity={session}
                listed
                onSignOut={() => signOut(session)}
              />
            </AccountCard>
          );
        })}
        {firstFailed && accountDetails}
        {problems}
      </div>
    </section>
  );
}

type SignOutFailure = Readonly<{
  authority: NonNullable<SessionSnapshot["authority"]>;
  failure: string;
}>;

/** A server's row title: its name, and its host when that differs. */
function serverTitle(authority: NonNullable<SessionSnapshot["authority"]>) {
  const host = new URL(authority.identityOrigin).host;
  const name = serverName(authority);
  return name === host ? host : `${name} (${host})`;
}

function needsRenewal(state: SessionSnapshot) {
  return (
    state.status === "signed-in" &&
    !!state.expiresAt &&
    new Date(state.expiresAt).getTime() <= Date.now() + 7 * 86_400_000
  );
}

/** One host and its current sign-in, with its actions and endnote below. */
function AccountCard({
  state,
  identity,
  children,
  endnote,
  memberships,
}: {
  state: SessionSnapshot;
  identity: FederatedIdentity;
  children: ReactNode;
  endnote?: ReactNode;
  memberships: readonly Membership[];
}) {
  const tilt = useIdentityTilt();
  const communityArtwork = useRef<HTMLDivElement>(null);
  const reflectionRegions = useCallback(
    () =>
      Array.from(
        communityArtwork.current?.querySelectorAll<HTMLElement>(
          "[data-community-icon]",
        ) ?? [],
        (element) => ({
          x: element.offsetLeft,
          y: element.offsetTop,
          width: element.offsetWidth,
          height: element.offsetHeight,
        }),
      ),
    [],
  );
  const authority = state.authority;
  const communities = useSignInMemberships(
    identity,
    authority?.communityHosts ?? [],
    memberships,
  );
  if (!authority) return null;
  const name = serverTitle(authority);
  const signedIn = state.status === "signed-in";
  const status = state.failure
    ? "Needs attention"
    : signedIn
      ? "Signed in"
      : state.status === "restoring"
        ? "Checking sign-in…"
        : state.status === "signing-in"
          ? "Signing in…"
          : "Not signed in";
  return (
    <article
      className={styles.accountEntry}
      aria-label={name}
      data-connected={signedIn}
      data-account-status={state.status}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={tilt.onPointerLeave}
    >
      <motion.div
        className={`interaction-panel text-standard ${styles.accountCard}`}
        style={tilt.style}
      >
        <div className="grid gap-1">
          <h4 className="m-0 text-body-lg">{name}</h4>
          {signedIn && (
            <p className="m-0 text-body-sm text-secondary">
              Signed in as{" "}
              <span className="text-label-sm text-standard">
                {state.email ?? "your organization account"}
              </span>
            </p>
          )}
          <p
            className={
              signedIn && !state.failure
                ? "sr-only"
                : "m-0 text-body-sm text-secondary"
            }
          >
            {status}
          </p>
        </div>
        {needsRenewal(state) && state.expiresAt && (
          <p className="m-0 text-caption text-secondary">
            Expires at{" "}
            {new Date(state.expiresAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        )}
        {communities.length > 0 && (
          <section
            aria-label="Saved communities for this host"
            className="grid gap-2"
          >
            <p className="m-0 text-caption text-secondary">
              {signedIn ? "Used to access" : "Sign in to access"}
            </p>
            <div className={styles.communityAssets} ref={communityArtwork}>
              <span className={styles.communityIcons}>
                {communities.slice(0, 6).map((membership) => {
                  const name = communityName(membership);
                  return (
                    <Tooltip key={membership.id} content={name}>
                      <span
                        className={styles.communityIcon}
                        role="img"
                        aria-label={name}
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users focus named artwork to read its tooltip.
                        tabIndex={0}
                        data-community-icon=""
                      >
                        <Avatar
                          src={communityIcon(
                            membership.publishedIcon ?? membership.icon,
                          )}
                          alt=""
                          fallback={name}
                          shape="squircle"
                          size="fill"
                        />
                      </span>
                    </Tooltip>
                  );
                })}
                {communities.length > 6 && (
                  <span className="text-caption text-subtle">
                    +{communities.length - 6}
                  </span>
                )}
              </span>
              <IdentityReflection
                x={tilt.x}
                y={tilt.y}
                active={!tilt.reducedMotion}
                surface="film"
                regions={reflectionRegions}
              />
            </div>
            <span className="sr-only">
              {communities.map(communityName).join(", ")}
            </span>
          </section>
        )}
      </motion.div>
      <div className={styles.accountFooter}>
        {endnote && <div>{endnote}</div>}
        <div className={styles.accountActions}>{children}</div>
      </div>
    </article>
  );
}

/** A provider's existing sign-in controls; `listed` places its row among accounts. */
function OrganizationSignIn({
  identity,
  accountRows,
  listed = false,
  memberships = [],
  onSignOut,
}: {
  identity: FederatedIdentity;
  accountRows?: ReactNode;
  listed?: boolean;
  memberships?: readonly Membership[];
  onSignOut?: () => void;
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState<{
    revision: string;
    message: string;
  } | null>(null);
  const problem =
    (failure?.revision === state.revision ? failure.message : "") ||
    state.failure;
  const trigger = useRef<HTMLButtonElement>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [confirmRevision, setConfirmRevision] = useState<string | null>(null);
  useEffect(() => setErrorOpen(!!problem), [problem]);
  if (!state.authority || state.status === "unconfigured") return null;
  // Preserve unavailable-host feedback without offering an unusable sign-in.
  if (state.status === "unavailable" && !listed)
    return (
      <>
        {problem && (
          <p role="alert" className="mt-6 text-body-sm text-danger">
            {recoveryMessage(problem)}
          </p>
        )}
      </>
    );
  const organization =
    state.authority.organization ||
    new URL(state.authority.identityOrigin).host;
  const signedIn = state.status === "signed-in";
  const signingIn = state.status === "signing-in";
  const renewing = needsRenewal(state);
  const signOutLabel = listed
    ? `Sign out of ${new URL(state.authority.identityOrigin).host}`
    : "Sign out of organization";
  function run(operation: () => Promise<unknown>) {
    setFailure(null);
    setErrorOpen(false);
    void Promise.resolve()
      .then(operation)
      .then(() => {
        // Native can return the same retained refusal on a retry.
        if (identity.snapshot().failure) setErrorOpen(true);
      })
      .catch((error: unknown) => {
        setFailure({
          revision: state.revision,
          message:
            error instanceof Error ? error.message : "Sign-in unavailable",
        });
        setErrorOpen(true);
      });
  }
  const renew = () =>
    run(() => {
      const current = identity.snapshot();
      return current.status === "signed-in" &&
        current.revision === state.revision
        ? identity.signIn()
        : Promise.resolve();
    });
  const content = (
    <>
      <PopoverRoot
        open={!listed && !!problem && errorOpen}
        onOpenChange={(open, details) => {
          // The trigger starts sign-in; failures alone open its supporting popup.
          if (details.reason !== "trigger-press") setErrorOpen(open);
        }}
      >
        <div
          ref={(element) => {
            // The primary action owns return focus, including SplitButton’s first half.
            trigger.current = element?.querySelector("button") ?? null;
          }}
        >
          {renewing ? (
            <SplitButton
              variant="prominent"
              size="sm"
              onClick={renew}
              menuLabel={`More actions for ${organization}`}
              menu={
                <MenuItem onClick={() => setConfirmRevision(state.revision)}>
                  Sign out
                </MenuItem>
              }
            >
              Renew sign-in
            </SplitButton>
          ) : (
            state.status !== "unavailable" && (
              <PopoverTrigger
                render={
                  <Button
                    variant={signedIn || signingIn ? "subtle" : "prominent"}
                    size="sm"
                    type="button"
                    disabled={state.status === "restoring"}
                    aria-label={signedIn ? signOutLabel : undefined}
                    onClick={() => {
                      if (signedIn) setConfirmRevision(state.revision);
                      else
                        run(() =>
                          signingIn
                            ? identity.cancelSignIn()
                            : identity.signIn(),
                        );
                    }}
                  >
                    {signedIn
                      ? listed
                        ? "Sign out"
                        : "Sign out of organization"
                      : signingIn
                        ? "Cancel sign-in"
                        : "Sign in"}
                  </Button>
                }
              />
            )
          )}
          {listed && problem && (
            <p role="alert" className="text-body-sm text-danger">
              {recoveryMessage(problem)}
            </p>
          )}
        </div>
        <PopoverPopup
          anchor={trigger}
          side="bottom"
          align="end"
          size="compact"
          finalFocus={trigger}
          aria-label="Account sign-in error"
        >
          <p role="alert" className="m-0 text-body-sm">
            {problem && recoveryMessage(problem)}
          </p>
        </PopoverPopup>
      </PopoverRoot>
      {signedIn && confirmRevision === state.revision && (
        <AlertDialog
          title={`Sign out of ${organization}?`}
          description={`Your Buzz identity stays on this device. You and your agents can’t reconnect to communities that require your ${organization} login until you sign back in.`}
          finalFocus={trigger}
          onClose={() => setConfirmRevision(null)}
          actions={
            <>
              <Button onClick={() => setConfirmRevision(null)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  setConfirmRevision(null);
                  run(() => {
                    const current = identity.snapshot();
                    return current.status === "signed-in" &&
                      current.revision === confirmRevision
                      ? onSignOut
                        ? Promise.resolve(onSignOut())
                        : identity.signOut()
                      : Promise.resolve();
                  });
                }}
              >
                Sign out
              </Button>
            </>
          }
        />
      )}
    </>
  );
  return listed ? (
    content
  ) : (
    <section className={styles.accounts} aria-label="Accounts">
      <div className={styles.accountList}>
        <AccountCard
          state={state}
          identity={identity}
          memberships={memberships}
          endnote={state.status !== "restoring" && accountRows}
        >
          {content}
        </AccountCard>
      </div>
    </section>
  );
}

function BackupRecovery({
  viewer,
  management,
  status,
  statusError,
  identity,
  offered,
  openBuilderlab,
  accountError,
  accountPending,
  onStatusError,
  onRetry,
  finalFocus,
}: {
  viewer: string;
  management: IdentityManagement | undefined;
  status: BackupStatus | undefined;
  statusError: boolean;
  identity: Identity;
  offered: boolean;
  openBuilderlab: (() => void) | undefined;
  accountError: boolean;
  accountPending: boolean;
  onStatusError(failed: boolean): void;
  onRetry(): void;
  finalFocus(): HTMLButtonElement | null;
}) {
  const { backup } = identity;
  const [asking, setAsking] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const backedUp = useRef(false);
  const close = useCallback((saved?: boolean) => {
    backedUp.current = saved === true;
    setAsking(false);
  }, []);
  const needsConsent =
    status?.status === "waiting" && status.reason === "no_consent";
  const waiting = offered && needsConsent;
  const settled =
    !!status &&
    status.status !== "running" &&
    status.status !== "idle" &&
    !needsConsent;
  const [failedAt, setFailedAt] = useState<number>();
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const confirmed =
    management?.initialBackupConfirmed || status?.status === "complete";
  const running = !!management && status?.status === "running";
  // A new native status retires a failed-start message from an earlier pass.
  const failure = failedAt !== undefined && failedAt === status?.seq;
  const problem =
    status?.status === "failed" ? BACKUP_FAILURES[status.kind] : undefined;
  const feedback = waiting
    ? "Back up this key to Builderlab"
    : statusError || accountError
      ? "Backup status unknown"
      : status?.status === "waiting"
        ? status.reason === "no_session"
          ? "Sign in to Builderlab to back up your key"
          : BACKUP_FAILURES.not_linked.message.replace(/\.$/, "")
        : problem &&
          ("cause" in problem ? problem.cause : problem.message).replace(
            /\.$/,
            "",
          );
  // These are the two waits whose next step is on Builderlab's Settings page.
  const at =
    openBuilderlab &&
    ((status?.status === "waiting" && status.reason === "not_linked") ||
      (status?.status === "failed" && status.kind === "other_key_linked"))
      ? (feedback?.indexOf("Builderlab") ?? -1)
      : -1;
  async function retry() {
    if (pending.current || running) return;
    pending.current = true;
    onRetry();
    setStarting(true);
    setFailedAt(undefined);
    try {
      if (!management) {
        const next = await backup.refresh().catch(() => undefined);
        if (!current.current) return;
        if (next?.management?.pubkey !== viewer) {
          onStatusError(true);
          return;
        }
        onStatusError(false);
        if (next.status === "running") return;
      }
      const ticket = await backup.retry();
      if (current.current && typeof ticket !== "number")
        setFailedAt(backup.snapshot()?.seq);
    } catch {
      if (current.current) setFailedAt(backup.snapshot()?.seq);
    } finally {
      pending.current = false;
      if (current.current) setStarting(false);
    }
  }
  const recovery =
    !!management &&
    (offered || management.policy === "organization-managed") &&
    (status?.status === "failed" ||
      (status?.status === "waiting" && !needsConsent) ||
      (management.policy === "organization-managed" && !confirmed));
  const busy = starting || running || (accountError && accountPending);
  if (
    !waiting &&
    !asking &&
    !statusError &&
    !accountError &&
    !recovery &&
    !busy &&
    !failure
  )
    return null;
  return (
    <div className={styles.keyNotice}>
      {(waiting ||
        statusError ||
        accountError ||
        (!confirmed && problem) ||
        status?.status === "waiting") && (
        <p
          role={statusError || accountError ? "status" : undefined}
          className="m-0 text-center text-caption text-subtle"
        >
          {feedback && at >= 0 ? (
            <>
              {feedback.slice(0, at)}
              <SettingsSectionLink
                section="block.builderlab/login"
                open={openBuilderlab}
              >
                Builderlab
              </SettingsSectionLink>
              {feedback.slice(at + "Builderlab".length)}
            </>
          ) : (
            feedback
          )}
        </p>
      )}
      {failure && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          Couldn’t start the backup. Try signing in again.
        </p>
      )}
      {waiting ? (
        <Button
          ref={action}
          variant="prominent"
          onClick={() => setAsking(true)}
        >
          Back up key
        </Button>
      ) : (
        <Button
          loading={busy}
          loadingAppearance="disabled"
          disabled={busy}
          onClick={() => void retry()}
        >
          Retry backup
        </Button>
      )}
      {asking && (
        <BackupPrompt
          identity={identity}
          pubkey={viewer}
          ended={settled}
          onClose={close}
          finalFocus={() =>
            (backedUp.current ? null : action.current) ?? finalFocus()
          }
        />
      )}
    </div>
  );
}

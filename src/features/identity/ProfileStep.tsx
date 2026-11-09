import { useState } from "react";
import type { inspectProfile } from "../communities/api";
import type { FoundCommunity } from "../communities/find-community";
import { canSaveProfile, ProfileFields } from "../communities/ProfileFields";
import type { PersonalProfile } from "../communities/service";
import { readErrorKind } from "../relay/errors";
import { Button } from "../../shared/design-system/ui/Button";
import { WireframePanel } from "./Wireframe";

/**
 * First-run profile, shown once the relay has admitted the key and before the
 * gate lifts. A pure form: the caller owns what Continue does with the
 * draft (the join's completion, which publishes the kind 0 through the shared
 * owner and saves the membership after it), and a rejection stays here with
 * the error inline and the draft intact.
 */
export function ProfileStep({
  found,
  read,
  defaultName,
  onContinue,
}: {
  found: Pick<FoundCommunity, "url" | "host">;
  /** The admission read that joined the community: the prefill. */
  read: Awaited<ReturnType<typeof inspectProfile>>;
  /** Suggested display name when the relay holds no profile for this key. */
  defaultName: string;
  /** Publishes the trimmed draft and finishes the join; a rejection keeps the step. */
  onContinue: (profile: PersonalProfile) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PersonalProfile>(() =>
    read.exists ? read.profile : { name: defaultName, picture: "", about: "" },
  );
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const canContinue = canSaveProfile(draft) && !busy && !uploading;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(publishFailure(found.host, reason));
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canContinue)
          void run(() =>
            onContinue({
              ...draft,
              name: draft.name.trim(),
              about: draft.about?.trim() ?? "",
            }),
          );
      }}
    >
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Set up your profile
        </h1>
        <p className="mt-2 break-all text-body text-subtle">{found.url}</p>
        <p className="mt-2 text-body text-subtle">
          Enter a name for your community profile. You can change it later.
        </p>
      </div>
      <WireframePanel>
        <ProfileFields
          showAbout={false}
          emptyAvatarStyle="dotted-circle"
          profile={draft}
          onChange={setDraft}
          disabled={busy}
          community={found.url}
          onBusyChange={setUploading}
          autoFocus
        />
      </WireframePanel>
      {error && (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      )}
      <div data-onboarding-actions="">
        <Button
          type="submit"
          size="lg"
          variant="prominent"
          loading={busy}
          disabled={!canContinue}
        >
          Continue
        </Button>
      </div>
    </form>
  );
}

/** Classified like the join's read failure; the owner's own messages (the
 * native route's "Community request failed (500)", an unconfirmed receipt, a
 * readback that is not current, a device record that will not save) are
 * shown as is. */
function publishFailure(host: string, error: unknown) {
  if (readErrorKind(error) === "denied")
    return `${host} no longer admits this key. Ask a community administrator to restore your access.`;
  return error instanceof Error
    ? error.message
    : "Could not reach the relay. Check your connection and try again.";
}

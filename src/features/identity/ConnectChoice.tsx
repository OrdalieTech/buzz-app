import { Avatar } from "../../shared/design-system/ui/Avatar";
import { OnboardingBack } from "./OnboardingBack";
import { Button } from "../../shared/design-system/ui/Button";

/**
 * Pause on a found community that this build's Builderlab does not host (one
 * it hosts signs in at once), before any sign-in: the relay cannot sign the
 * user in, but Buzz still needs a key. Connect runs the build portal's sign-in
 * exactly as the landing's button does (the key it creates is linked to that
 * account, with automatic backup); the import brings a key with no account to
 * link it to. Either way setup ends on Join Community for the found address.
 */
export function ConnectChoice({
  host,
  onConnect,
  onImport,
  onBack,
}: {
  /** The found community's host, as the find page shows it. */
  host: string;
  /** Sign in at the build portal and continue as the landing’s Sign in with Builderlab does. */
  onConnect: () => void;
  /** The user already has a key: open the import page. */
  onImport: () => void;
  /** Return to the landing with the address kept. */
  onBack: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Connect to your community
        </h1>
        <p className="mt-2 text-body text-subtle">
          Sign in to your Builderlab account with email, or use an existing
          private key to continue.
        </p>
      </div>
      <div
        className="flex w-full items-center gap-3 p-4 text-left"
        style={{
          background: "var(--affordance-subtle)",
          borderRadius: "var(--radius-control)",
        }}
      >
        <Avatar alt="" fallback={host} fallbackSurface="panel" size="large" />
        <span className="min-w-0 flex-1 break-all text-body-sm text-standard">
          {host}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="prominent" size="lg" onClick={onConnect}>
          Sign in with Builderlab
        </Button>
        <Button size="lg" data-return-focus="import" onClick={onImport}>
          Use an existing key
        </Button>
      </div>
      <div data-onboarding-actions="">
        <OnboardingBack onClick={onBack} />
      </div>
    </>
  );
}

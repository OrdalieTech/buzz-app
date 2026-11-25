import { useState, useSyncExternalStore } from "react";
import { SettingsSectionLink } from "../features/navigation/SettingsSectionLink";
import type { SpeechService } from "../features/speech/service";
import { useDictation } from "../features/speech/use-dictation";
import { OwnedContribution } from "../plugins/OwnedContribution";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";

/** Chooses the provider that turns speech into text on this device, shows
 * its settings, and lets the person try it. Providers are plugins. */
export function SpeechSettings({
  speech,
  community,
  active,
  onSection,
}: {
  speech: Pick<
    SpeechService,
    | "backend"
    | "status"
    | "subscribe"
    | "setBackend"
    | "providers"
    | "statusOf"
    | "listen"
  >;
  /** The selected community's relay URL, which a try bills. */
  community?: string | undefined;
  active(): boolean;
  onSection?: ((section: string) => void) | undefined;
}) {
  const backend = useSyncExternalStore(
    speech.subscribe,
    speech.backend,
    speech.backend,
  );
  const status = useSyncExternalStore(
    speech.subscribe,
    speech.status,
    speech.status,
  );
  const providers = useSyncExternalStore(
    speech.subscribe,
    speech.providers,
    speech.providers,
  );
  const shown = providers.find((provider) => provider.key === backend);
  const choose = (key: string) => {
    if (active()) speech.setBackend(key);
  };
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState("");
  const dictation = useDictation(speech, {
    onText: setHeard,
    onEnd: setHeard,
    onError: (_, message) => setProblem(message),
  });
  const listening = dictation.state !== "idle";
  const tryIt = () => {
    if (!active()) return;
    if (listening) return dictation.stop();
    setHeard("");
    setProblem("");
    dictation.start(community ? { community } : {});
  };
  return (
    <section tabIndex={-1} aria-labelledby="speech-settings-title">
      <Header
        id="speech-settings-title"
        title="Speech to text"
        subtitle={
          <>
            Features that listen turn what you say into text with this provider.
            It receives the audio while you speak.
          </>
        }
      />
      {providers.length === 0 ? (
        <p role="status" className="mt-4 text-body-sm text-secondary">
          No speech provider is available on this device. Turn one on in{" "}
          <SettingsSectionLink section="plugins" open={onSection}>
            Manage plugins
          </SettingsSectionLink>
          .
        </p>
      ) : (
        <div
          data-buzz-ui=""
          className="mt-section-gap flex flex-col items-start gap-section-gap"
        >
          <div className="w-full max-w-md">
            <InlineHeader title="Speech provider" />
            <Field
              label="Speech provider"
              labelVisibility="hidden"
              nativeLabel={false}
            >
              <RadioGroup
                aria-label="Speech provider"
                value={backend ?? ""}
                onValueChange={choose}
                // The listen keeps its provider, so the choice waits for Stop.
                disabled={listening}
              >
                {providers.map((provider) => (
                  <Radio
                    key={provider.key}
                    value={provider.key}
                    variant="card"
                    label={provider.label}
                    description={provider.description}
                  />
                ))}
              </RadioGroup>
            </Field>
          </div>
          {shown?.Settings && (
            <div className="w-full">
              <InlineHeader title={shown.label} />
              <OwnedContribution
                entry={shown}
                registry={{ snapshot: () => providers }}
                fallback={
                  <p role="alert" className="text-body-sm text-secondary">
                    {shown.label} settings are unavailable. You can turn its
                    plugin off in{" "}
                    <SettingsSectionLink section="plugins" open={onSection}>
                      Manage plugins
                    </SettingsSectionLink>
                    .
                  </p>
                }
              >
                {(entry, owned) => {
                  const Settings = entry.Settings;
                  return (
                    Settings && <Settings active={() => active() && owned()} />
                  );
                }}
              </OwnedContribution>
            </div>
          )}
          <div className="flex w-full max-w-md flex-col items-start gap-2">
            <InlineHeader title="Try it" />
            <Button
              variant="outline"
              disabled={
                !listening &&
                (status === "unavailable" ||
                  status === "needs-setup" ||
                  !community)
              }
              onClick={tryIt}
            >
              {listening ? "Stop" : "Start listening"}
            </Button>
            {!community && (
              <p className="m-0 text-body-sm text-secondary">
                Select a community to try speech to text. It bills that
                community.
              </p>
            )}
            {(heard || listening) && (
              <p role="status" aria-live="polite" className="m-0 text-body-sm">
                {heard ||
                  (dictation.state === "listening"
                    ? "Listening…"
                    : "Starting…")}
              </p>
            )}
            {problem && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {problem}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

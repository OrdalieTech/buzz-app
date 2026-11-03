import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "../src/features/identity/IdentitySetup.module.css";
import {
  classifyKeyImport,
  readKeyFile,
} from "../src/features/identity/key-import";
import { OnboardingScreen } from "../src/features/identity/OnboardingScreen";
import { PrivateKey } from "../src/features/identity/PrivateKey";
import type { Identity } from "../src/features/identity/service";
import { Button } from "../src/shared/design-system/ui/Button";
import { Field } from "../src/shared/design-system/ui/Field";
import { Input } from "../src/shared/design-system/ui/Input";
import { key } from "./commands.ts";

// The web build's first-run key pages, standing in for upstream's
// ConnectChoice and KeyImport in Welcome.tsx (vite.web.config.ts). There is no
// email sign-in, so the choice is to create a key, bring one (nsec or NIP-49
// backup) or pair with Buzz desktop. The key Worker holds that key unsaved
// (key-setup.ts) until Continue hands its npub to Welcome's import, which
// saves it create-only.

type Lane = "create" | "restore" | "pair";
let lane: Lane = "restore";
const call = <T,>(command: string, args: object = {}) =>
  key(args as Record<string, unknown>, command) as Promise<T>;
const text = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function ConnectChoice({
  host,
  onImport,
  onBack,
}: {
  host: string;
  onConnect: () => void;
  onImport: () => void;
  onBack: () => void;
}) {
  const open = (next: Lane) => () => {
    lane = next;
    onImport();
  };
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
        <p className="mt-2 break-all font-mono text-mono-lg text-standard">
          {host}
        </p>
        <p className="mt-2 text-body text-subtle">
          Buzz relies on a private key, kept on this device, for your identity.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button variant="prominent" size="lg" onClick={open("create")}>
          Create my key
        </Button>
        <Button size="sm" data-return-focus="import" onClick={open("restore")}>
          I already have a key
        </Button>
        <Button size="sm" onClick={open("pair")}>
          Pair with Buzz desktop
        </Button>
      </div>
      <div className="flex gap-3">
        <Button onClick={onBack}>Back</Button>
      </div>
    </>
  );
}

type Props = { onBack: () => void; onImport: (nsec: string) => Promise<void> };

export function KeyImport(props: Props & { expectedPubkey?: string }) {
  const Page = { create: CreateKey, restore: RestoreKey, pair: PairKey }[lane];
  return <Page {...props} />;
}

/** Runs one action at a time, keeping its refusal for the page. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(text(reason));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

function Screen({
  title,
  body,
  children,
  actions,
}: {
  title: string;
  body: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <div className={styles.importContent}>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            {title}
          </h1>
          <p className="text-body text-subtle">{body}</p>
          <div className={styles.importForm}>{children}</div>
        </div>
      }
    >
      {actions}
    </OnboardingScreen>
  );
}

/** A new key, kept only after the user saved a backup of it. */
function CreateKey({ onBack, onImport }: Props) {
  const [npub, setNpub] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const [exporter] = useState(
    () => ({ exportKey: () => call("setup_export") }) as unknown as Identity,
  );
  useEffect(() => {
    void run(async () => setNpub(await call<string>("setup_create")));
  }, [run]);
  const mismatch = !!repeat && repeat !== password;
  const download = () =>
    run(async () => {
      const backup = await call<string>("setup_backup", { password });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(
        new Blob([`${backup}\n`], { type: "text/plain" }),
      );
      link.download = "buzz-key-backup.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      setSaved(true);
    });
  return (
    <Screen
      title="Back up your key"
      body="Your key exists only on this device. Save a password-protected backup file, or copy the key itself, before you continue: without one, a lost device or cleared browser data loses this identity."
      actions={
        <>
          <Button
            size="lg"
            variant="prominent"
            disabled={!saved || !npub}
            loading={busy && saved}
            onClick={() => void run(() => onImport(npub))}
          >
            Continue
          </Button>
          <Button size="lg" variant="ghost" onClick={onBack}>
            Back
          </Button>
        </>
      }
    >
      <p className="m-0 text-body-sm text-subtle">
        Public identity:{" "}
        <code className="select-text break-all font-mono text-mono">
          {npub}
        </code>
      </p>
      <Field
        label="Backup password"
        description="At least 12 characters. You need it to restore the backup."
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          onValueChange={setPassword}
        />
      </Field>
      <Field
        label="Repeat password"
        error={mismatch ? "The passwords don’t match." : error}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={repeat}
          onValueChange={setRepeat}
        />
      </Field>
      <Button
        disabled={!password || repeat !== password}
        loading={busy && !saved}
        onClick={() => void download()}
      >
        Download backup file
      </Button>
      <PrivateKey identity={exporter} onInteraction={() => setSaved(true)} />
    </Screen>
  );
}

/** An nsec, or a NIP-49 backup with its password. */
function RestoreKey({ onBack, onImport }: Props) {
  const [value, setValue] = useState("");
  const [password, setPassword] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  const input = classifyKeyImport(value);
  const encrypted = input.kind === "encrypted";
  const submit = () =>
    run(async () =>
      onImport(
        encrypted
          ? await call<string>("setup_open", { ncryptsec: value, password })
          : input.kind === "nsec"
            ? input.nsec
            : "",
      ),
    );
  return (
    <Screen
      title="Enter your private key"
      body="Paste your private key or your password-protected backup, or choose the backup file."
      actions={
        <>
          <Button
            size="lg"
            variant="prominent"
            disabled={input.kind !== "nsec" && !(encrypted && password)}
            loading={busy}
            onClick={() => void submit()}
          >
            Continue with this key
          </Button>
          <Button size="lg" variant="ghost" onClick={onBack}>
            Back
          </Button>
        </>
      }
    >
      <Field
        label="Private key or backup"
        error={
          input.kind === "invalid"
            ? "Paste an nsec1 key or an ncryptsec1 backup."
            : !encrypted && error
        }
        description={input.kind === "nsec" && `Public identity: ${input.npub}`}
      >
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="nsec1… or ncryptsec1…"
          value={value}
          onValueChange={setValue}
          autoFocus
        />
      </Field>
      {encrypted && (
        <Field label="Backup password" error={error}>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onValueChange={setPassword}
          />
        </Field>
      )}
      <Button size="sm" onClick={() => picker.current?.click()}>
        Choose a backup file
      </Button>
      <input
        ref={picker}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Backup file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void run(async () => setValue(await readKeyFile(file)));
        }}
      />
    </Screen>
  );
}

/** Receives the identity Buzz desktop sends from Pair mobile. */
function PairKey({ onBack, onImport }: Props) {
  const [code, setCode] = useState("");
  const [sas, setSas] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => () => void call("setup_pair_cancel"), []);
  return (
    <Screen
      title="Pair with Buzz desktop"
      body={
        sas ? (
          <>
            Check that Buzz desktop shows{" "}
            <strong className="font-mono">{`${sas.slice(0, 3)} ${sas.slice(3)}`}</strong>
            . If it does, choose Codes match there and here.
          </>
        ) : (
          "In Buzz desktop, open Pair mobile in Settings and copy the pairing code, then paste it here."
        )
      }
      actions={
        <>
          <Button
            size="lg"
            variant="prominent"
            disabled={!code.trim()}
            loading={busy}
            onClick={() =>
              void run(async () => {
                if (!sas)
                  return setSas(await call<string>("setup_pair", { code }));
                await call<string>("setup_pair_confirm")
                  .then(onImport)
                  .catch((reason) => {
                    // The session is over: a new try needs a new code.
                    setSas("");
                    throw reason;
                  });
              })
            }
          >
            {sas ? "Codes match" : "Continue"}
          </Button>
          <Button size="lg" variant="ghost" onClick={onBack}>
            Back
          </Button>
        </>
      }
    >
      <Field label="Pairing code" error={error}>
        <Input
          autoComplete="off"
          spellCheck={false}
          placeholder="nostrpair://…"
          value={code}
          disabled={!!sas}
          onValueChange={setCode}
          autoFocus
        />
      </Field>
    </Screen>
  );
}

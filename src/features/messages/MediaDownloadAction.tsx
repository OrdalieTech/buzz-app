import { useEffect, useState } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowsClockwiseIcon,
  CheckIcon,
  DownloadIcon,
} from "../../shared/design-system/icons";
import { useNativeDownload } from "./use-native-download";
import { isNativeMediaSource, isProxySource } from "./attachment-source";

const FAILURE_DURATION = 6000;

export function MediaDownloadAction({
  source,
  name = "",
  kind,
  compact = false,
  savedDuration = 4000,
  onFeedbackVisible,
}: {
  source: string;
  name?: string | undefined;
  kind: string;
  compact?: boolean;
  savedDuration?: number;
  onFeedbackVisible?: ((visible: boolean) => void) | undefined;
}) {
  if (
    !isNativeMediaSource(source) &&
    !(import.meta.env.VITE_BUZZ_BROWSER_HOST === "1" && isProxySource(source))
  )
    return null;
  return (
    <NativeMediaDownload
      key={JSON.stringify([source, name, kind])}
      source={source}
      name={name}
      kind={kind}
      compact={compact}
      savedDuration={savedDuration}
      onFeedbackVisible={onFeedbackVisible}
    />
  );
}

function NativeMediaDownload({
  source,
  name,
  kind,
  compact,
  savedDuration,
  onFeedbackVisible,
}: {
  source: string;
  name: string;
  kind: string;
  compact: boolean;
  savedDuration: number;
  onFeedbackVisible?: ((visible: boolean) => void) | undefined;
}) {
  const { state, download } = useNativeDownload(source, name, savedDuration);
  // The failure notice expires like the copy error; the retry icon remains.
  const [failureExpired, setFailureExpired] = useState(false);
  const failureShown = state === "failed" && !failureExpired;
  useEffect(() => {
    if (!failureShown) return;
    const timer = setTimeout(() => setFailureExpired(true), FAILURE_DURATION);
    return () => clearTimeout(timer);
  }, [failureShown]);
  const feedbackVisible =
    state === "pending" || state === "saved" || failureShown;
  useEffect(() => {
    onFeedbackVisible?.(feedbackVisible);
    return () => onFeedbackVisible?.(false);
  }, [feedbackVisible, onFeedbackVisible]);
  return (
    <>
      <IconButton
        hint="familiar"
        size="sm"
        type="button"
        aria-label={
          state === "failed" ? `Retry download ${kind}` : `Download ${kind}`
        }
        title={
          state === "failed" ? `Retry download ${kind}` : `Download ${kind}`
        }
        loading={state === "pending"}
        onClick={() => {
          setFailureExpired(false);
          void download();
        }}
        icon={
          state === "failed" ? (
            <ArrowsClockwiseIcon size={17} aria-hidden="true" />
          ) : state === "saved" ? (
            <CheckIcon size={17} aria-hidden="true" />
          ) : (
            <DownloadIcon size={17} aria-hidden="true" />
          )
        }
      />
      {/* Stays mounted so screen readers announce the first change. */}
      <span
        data-download-feedback={feedbackVisible ? "" : undefined}
        role={failureShown ? "alert" : "status"}
        className={feedbackVisible ? undefined : "sr-only"}
      >
        {state === "pending"
          ? "Downloading…"
          : state === "saved"
            ? compact
              ? "Downloaded"
              : "Saved to Downloads"
            : failureShown
              ? compact
                ? "Download failed"
                : "Couldn’t download. Try again."
              : ""}
      </span>
    </>
  );
}

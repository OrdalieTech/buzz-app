import { useEffect, useMemo, useState } from "react";
import { ArrowSquareOutIcon } from "../../shared/design-system/icons/index";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { DiffViewer } from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import type { GitHubDiff } from "./gh";
import { readable } from "./object";
import styles from "./GitHub.module.css";

/** One patch per file, so a file the parser cannot render falls back to raw
 * text without taking the rest of the diff with it. */
export function splitPatch(content: string): string[] {
  return content.split(/^(?=diff --git )/m).filter((part) => part.trim());
}

/** A pull request's Files changed, read for the base and head it names. */
export function PullFiles({
  url,
  pull,
  diff,
}: {
  url: string;
  pull: Parameters<GitHubDiff>[0];
  diff: GitHubDiff;
}) {
  const { repository, base, head, merged } = pull;
  const [result, setResult] = useState<string | Error>();
  useEffect(() => {
    const controller = new AbortController();
    diff({ repository, base, head, merged }, controller.signal).then(
      (content) => {
        if (!controller.signal.aborted) setResult(content);
      },
      (failure) => {
        if (!controller.signal.aborted) setResult(readable(failure));
      },
    );
    return () => controller.abort();
  }, [diff, repository, base, head, merged]);
  const parts = useMemo(
    () =>
      typeof result === "string"
        ? splitPatch(result).map((content) => ({
            content,
            files: parsePatch(content),
          }))
        : undefined,
    [result],
  );
  return (
    <LoadingRegion
      pending={result === undefined}
      label="Loading changes from GitHub…"
      feedback={
        result instanceof Error ? (
          <div role="alert">
            <p>{result.message}</p>
            <a
              className={styles.external}
              href={`${url}/files`}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub <ArrowSquareOutIcon size={14} />
            </a>
          </div>
        ) : undefined
      }
    >
      {parts &&
        (parts.length ? (
          <div className={styles.files}>
            {parts.map((part, index) => (
              <DiffViewer
                // biome-ignore lint/suspicious/noArrayIndexKey: A file's patch can repeat; its place in this diff cannot.
                key={index}
                content={part.content}
                files={part.files}
              />
            ))}
          </div>
        ) : (
          <p className={styles.files}>No file changes.</p>
        ))}
    </LoadingRegion>
  );
}

import { ReadError, transientStatus } from "../../features/relay/errors";
import type { GitHubReference } from "./references";

export type Branch = { label: string; url?: string | undefined };

export type GitHubDetails = {
  title: string;
  body: string;
  bodyHtml?: string | undefined;
  state: string;
  /** Why an issue was closed, as GitHub gives it, such as `not_planned`. */
  stateReason?: string | undefined;
  /** Read as an issue, it is a pull request: GitHub numbers both alike, and
   * its issues answer for either. */
  pullRequest?: true | undefined;
  author: string;
  headSha?: string | undefined;
  authorUrl?: string | undefined;
  authorAvatar?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  mergedAt?: string | undefined;
  mergedBy?: string | undefined;
  mergedByUrl?: string | undefined;
  facts: [
    string,
    (
      | string
      | number
      | { additions: number; deletions: number }
      | { head: Branch; base: Branch }
    ),
  ][];
};
export type BranchData = {
  label: string;
  ref?: string;
  repo?: { full_name: string } | null;
};

type ResponseData = {
  title?: string;
  description?: string | null;
  body?: string | null;
  body_html?: string | null;
  state?: string;
  state_reason?: string | null;
  pull_request?: object | null;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: { login?: string } | null;
  updated_at?: string;
  created_at?: string;
  user?: { login: string; avatar_url?: string };
  owner?: { login: string };
  author?: { login: string };
  commit?: { message: string; author: { name: string } };
  base?: BranchData;
  head?: BranchData & { sha?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  stargazers_count?: number;
  language?: string | null;
  default_branch?: string;
};

/** GitHub refused a public read for this hour's limit; `resetAt` is when it
 * lifts, by its `x-ratelimit-reset` header, or an hour on without one. */
export class GitHubRateLimited extends Error {
  constructor(readonly resetAt: number) {
    super(
      "GitHub’s public API limit was reached. Try again later or open it on GitHub.",
    );
  }
}

export function branchLink(branch: BranchData, pullRepository: string): Branch {
  const repository = branch.repo?.full_name;
  return {
    label:
      repository?.toLowerCase() === pullRepository.toLowerCase() && branch.ref
        ? branch.ref
        : branch.label,
    url:
      repository &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
      branch.ref
        ? `https://github.com/${repository}/tree/${branch.ref.split("/").map(encodeURIComponent).join("/")}`
        : undefined,
  };
}

export async function loadGitHubDetails(
  reference: GitHubReference,
  signal: AbortSignal,
): Promise<GitHubDetails> {
  const url = new URL(reference.url);
  const id = url.pathname.split("/").at(-1);
  const surface = {
    repository: "",
    pull: `/pulls/${id}`,
    issue: `/issues/${id}`,
    commit: `/commits/${id}`,
  }[reference.kind];
  const response = await fetch(
    `https://api.github.com/repos/${reference.repository}${surface}`,
    {
      signal,
      headers: { Accept: "application/vnd.github.full+json" },
      credentials: "omit",
    },
  );
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        "This is private or unavailable. Sign in to the gh CLI to see private repositories, or open it on GitHub.",
      );
    if (response.status === 403 || response.status === 429)
      throw new GitHubRateLimited(
        Number(response.headers.get("x-ratelimit-reset")) * 1000 ||
          Date.now() + 60 * 60_000,
      );
    const message = `GitHub couldn’t load this object (${response.status}).`;
    // `loadGitHubObject` retries server failures quietly.
    throw transientStatus(response.status)
      ? new ReadError("unavailable", message, response.status)
      : new Error(message);
  }
  const data: ResponseData = await response.json();
  const facts: GitHubDetails["facts"] = [];
  if (data.head && data.base)
    facts.push([
      "Branch",
      {
        head: branchLink(data.head, reference.repository),
        base: branchLink(data.base, reference.repository),
      },
    ]);
  if (data.changed_files !== undefined)
    facts.push(["Files changed", data.changed_files]);
  if (data.additions !== undefined && data.deletions !== undefined)
    facts.push([
      "Changes",
      { additions: data.additions, deletions: data.deletions },
    ]);
  if (reference.kind !== "pull" && data.comments !== undefined)
    facts.push(["Comments", data.comments]);
  if (data.stargazers_count !== undefined)
    facts.push(["Stars", data.stargazers_count]);
  if (data.language) facts.push(["Language", data.language]);
  if (data.default_branch) facts.push(["Default branch", data.default_branch]);
  const [commitTitle, ...commitBody] = data.commit?.message.split("\n") ?? [];
  const accountLogin =
    data.user?.login ??
    data.author?.login ??
    (data.commit?.author.name === undefined ? data.owner?.login : undefined);
  return {
    title: data.title ?? commitTitle ?? reference.repository,
    body: data.body ?? data.description ?? commitBody.join("\n").trim(),
    bodyHtml: data.body_html ?? undefined,
    headSha: reference.kind === "pull" ? data.head?.sha : undefined,
    state: data.merged
      ? "Merged"
      : data.state === "closed"
        ? "closed"
        : data.draft
          ? "Draft"
          : (data.state ?? ""),
    stateReason: data.state_reason ?? undefined,
    pullRequest: data.pull_request ? true : undefined,
    author:
      data.user?.login ??
      data.author?.login ??
      data.commit?.author.name ??
      data.owner?.login ??
      "",
    authorUrl:
      accountLogin && /^[a-z0-9-]+$/i.test(accountLogin)
        ? `https://github.com/${encodeURIComponent(accountLogin)}`
        : undefined,
    authorAvatar:
      data.user?.avatar_url &&
      /^https:\/\/avatars\.githubusercontent\.com\//.test(data.user.avatar_url)
        ? data.user.avatar_url
        : undefined,
    createdAt:
      reference.kind === "pull" &&
      data.created_at &&
      Number.isFinite(Date.parse(data.created_at))
        ? data.created_at
        : undefined,
    updatedAt:
      reference.kind === "pull" &&
      data.updated_at &&
      Number.isFinite(Date.parse(data.updated_at))
        ? data.updated_at
        : undefined,
    mergedAt:
      reference.kind === "pull" &&
      data.merged &&
      data.merged_at &&
      Number.isFinite(Date.parse(data.merged_at))
        ? data.merged_at
        : undefined,
    mergedBy: data.merged_by?.login,
    mergedByUrl:
      data.merged_by?.login && /^[a-z0-9-]+$/i.test(data.merged_by.login)
        ? `https://github.com/${encodeURIComponent(data.merged_by.login)}`
        : undefined,
    facts,
  };
}

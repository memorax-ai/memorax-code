import { writeFileSync } from "node:fs";
import {
  assertRange,
  canonicalPath,
  commandAvailable,
  commandOutput,
  delay,
  failedOutput,
  mapConcurrent,
  parseInteger,
  RepoMemoryError,
  requiredValue,
  runCommand,
  runCommandAsync,
  type CommandOutput,
} from "./shared.js";
import {
  bodyText,
  boundedSummary,
  commitHeadline,
  commitSha,
  extractSymbols,
  integerField,
  isGitAncestor,
  isObject,
  objectList,
  resolveSnapshotSha,
  textField,
  uniqueNumbers,
  uniqueStrings,
  type JsonObject,
} from "./provider-shared.js";

const PR_LIST_FIELDS = "number,title,state,url,updatedAt,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft";
const PR_VIEW_FIELDS = "number,title,body,state,url,updatedAt,createdAt,closedAt,mergedAt,author,comments,reviews,latestReviews,reviewDecision,files,commits,closingIssuesReferences,mergeCommit,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,additions,deletions,changedFiles";
const ISSUE_LIST_FIELDS = "number,title,state,url,updatedAt,labels";
const ISSUE_VIEW_FIELDS = "number,title,body,state,url,updatedAt,labels,comments";
const DEFAULT_GH_RETRIES = 3;
const DEFAULT_GH_RETRY_DELAY_MS = 1000;
const TRANSIENT_GH_ERROR = /EOF|timeout|timed out|connection reset|connection refused|temporarily unavailable|TLS handshake timeout|502|503|504|rate limit|secondary rate limit|abuse detection/i;

export interface GithubFacetOptions {
  repo: string;
  hostname: string;
  repoPath: string;
  snapshotRef: string;
  prLimit: number;
  issueLimit: number;
  state: "all" | "open" | "closed";
  include: Set<"prs" | "issues">;
  concurrency: number;
  summaryChars: number;
  retries: number;
  retryDelayMs: number;
}

export async function fetchGithubFacets(
  options: GithubFacetOptions,
  writeStderr: (message: string) => void = (message) => process.stderr.write(message),
): Promise<JsonObject[]> {
  await assertGhReady(options.hostname, writeStderr);
  const selectedRepo = repoSelector(options.repo, options.hostname);
  const repoPath = canonicalPath(options.repoPath);
  const snapshotSha = options.snapshotRef && options.include.has("prs")
    ? resolveSnapshotSha(repoPath, options.snapshotRef, "PR")
    : "";
  const facets: JsonObject[] = [];
  if (options.include.has("prs")) {
    facets.push(...await fetchPrFacets(
      selectedRepo,
      options.repo,
      repoPath,
      snapshotSha,
      options.prLimit,
      options.state,
      options.concurrency,
      options.summaryChars,
      options.retries,
      options.retryDelayMs,
      writeStderr,
    ));
  }
  if (options.include.has("issues")) {
    const candidates = await ghList("issue", selectedRepo, options.issueLimit, options.state, options.retries, options.retryDelayMs, writeStderr);
    const numbers = objectList(candidates).map((item) => integerField(item)).filter((value): value is number => value !== undefined);
    const issues = await mapConcurrent(numbers, options.concurrency, async (number) => {
      const detail = await ghView("issue", selectedRepo, number, options.retries, options.retryDelayMs, writeStderr);
      return issueDetailToFacet(options.repo, detail, options.summaryChars);
    });
    facets.push(...issues);
  }
  return facets;
}

export async function executeGithubFacets(args: string[]): Promise<CommandOutput> {
  try {
    const parsed = parseGithubArgs(args);
    if (parsed.help) return { exitCode: 0, stdout: `${githubFacetsUsage()}\n`, stderr: "" };
    let stderr = "";
    const facets = await fetchGithubFacets(parsed.options, (message) => { stderr += message; });
    const output = commandOutput(facets, parsed.pretty);
    if (parsed.out) {
      writeFileSync(canonicalPath(parsed.out), output.stdout, "utf8");
      return { exitCode: 0, stdout: "", stderr };
    }
    return { ...output, stderr };
  } catch (error) {
    return failedOutput(error);
  }
}

export function githubFacetsUsage(): string {
  return "Usage: memorax-code repo-memory github-facets --repo OWNER/NAME [options]";
}

function parseGithubArgs(args: string[]): {
  options: GithubFacetOptions;
  pretty: boolean;
  out?: string;
  help?: boolean;
} {
  const options: GithubFacetOptions = {
    repo: "",
    hostname: "",
    repoPath: ".",
    snapshotRef: "",
    prLimit: 30,
    issueLimit: 30,
    state: "all",
    include: new Set(["prs", "issues"]),
    concurrency: 3,
    summaryChars: 4000,
    retries: DEFAULT_GH_RETRIES,
    retryDelayMs: DEFAULT_GH_RETRY_DELAY_MS,
  };
  let pretty = false;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--repo") options.repo = requiredValue(args, index++, value);
    else if (value === "--hostname") options.hostname = requiredValue(args, index++, value);
    else if (value === "--repo-path") options.repoPath = requiredValue(args, index++, value);
    else if (value === "--snapshot-ref") options.snapshotRef = requiredValue(args, index++, value);
    else if (value === "--pr-limit") options.prLimit = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--issue-limit") options.issueLimit = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--concurrency") options.concurrency = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--gh-retries") options.retries = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--gh-retry-delay-ms") options.retryDelayMs = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--summary-chars") options.summaryChars = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--state") {
      const state = requiredValue(args, index++, value);
      if (state !== "all" && state !== "open" && state !== "closed") throw new RepoMemoryError("--state must be all, open, or closed", 2);
      options.state = state;
    } else if (value === "--include") {
      const include = requiredValue(args, index++, value).split(",").map((part) => part.trim()).filter(Boolean);
      if (!include.length || include.some((part) => part !== "prs" && part !== "issues")) {
        throw new RepoMemoryError("--include must contain prs, issues, or prs,issues", 2);
      }
      options.include = new Set(include as Array<"prs" | "issues">);
    } else if (value === "--out") out = requiredValue(args, index++, value);
    else if (value === "--pretty") pretty = true;
    else if (value === "--help" || value === "-h") return { options, pretty, out, help: true };
    else throw new RepoMemoryError(`unrecognized arguments: ${value}`, 2);
  }
  if (!/^[^/]+\/[^/]+$/.test(options.repo)) throw new RepoMemoryError("--repo must be owner/name", 2);
  assertRange("--pr-limit", options.prLimit, 1, 100);
  assertRange("--issue-limit", options.issueLimit, 1, 100);
  assertRange("--concurrency", options.concurrency, 1, 10);
  assertRange("--gh-retries", options.retries, 0, 10);
  if (options.retryDelayMs < 0) throw new RepoMemoryError("--gh-retry-delay-ms must be non-negative", 2);
  if (options.summaryChars < 100) throw new RepoMemoryError("--summary-chars must be at least 100", 2);
  return { options, pretty, ...(out ? { out } : {}) };
}

async function runGh(
  args: string[],
  retries: number,
  retryDelayMs: number,
  writeStderr: (message: string) => void,
): Promise<unknown> {
  if (!commandAvailable("gh")) throw new RepoMemoryError("GitHub CLI 'gh' is required. Install it and run: gh auth login");
  const attempts = Math.max(1, retries + 1);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runCommandAsync("gh", args, { cwd: process.cwd() });
    last = result;
    if (result.status === 0) {
      const text = result.stdout.trim();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new RepoMemoryError(`gh ${args.join(" ")} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (attempt < attempts && TRANSIENT_GH_ERROR.test(`${result.stderr}\n${result.stdout}`)) {
      const delayMs = Math.max(0, retryDelayMs) * (2 ** (attempt - 1));
      writeStderr(`gh ${args.join(" ")} failed with transient error; retrying ${attempt}/${retries} after ${(delayMs / 1000).toFixed(1)}s: ${result.stderr.trim()}\n`);
      await delay(delayMs);
      continue;
    }
    break;
  }
  throw new RepoMemoryError(`gh ${args.join(" ")} failed:\n${last?.stderr.trim() ?? ""}`);
}

async function assertGhReady(hostname: string, writeStderr: (message: string) => void): Promise<void> {
  if (!commandAvailable("gh")) throw new RepoMemoryError("GitHub CLI 'gh' is required. Install it and run: gh auth login");
  const args = ["auth", "status", ...(hostname ? ["--hostname", hostname] : [])];
  const attempts = DEFAULT_GH_RETRIES + 1;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runCommand("gh", args, { cwd: process.cwd() });
    last = result;
    if (result.status === 0) return;
    if (attempt < attempts && TRANSIENT_GH_ERROR.test(`${result.stderr}\n${result.stdout}`)) {
      const delayMs = DEFAULT_GH_RETRY_DELAY_MS * (2 ** (attempt - 1));
      writeStderr(`gh auth status failed with transient error; retrying ${attempt}/${DEFAULT_GH_RETRIES} after ${(delayMs / 1000).toFixed(1)}s: ${result.stderr.trim()}\n`);
      await delay(delayMs);
      continue;
    }
    break;
  }
  if (!last) throw new RepoMemoryError("gh auth check failed");
  const details = [
    ...(last.stderr.trim() ? [`stderr: ${last.stderr.trim()}`] : []),
    ...(last.stdout.trim() ? [`stdout: ${last.stdout.trim()}`] : []),
  ];
  const detail = details.join("\n") || "gh auth status returned no diagnostic output";
  throw new RepoMemoryError(`gh auth check failed with exit code ${last.status}. Run: ${loginHint(hostname)}\n${detail}`);
}

function loginHint(hostname: string): string {
  return hostname && hostname !== "github.com" ? `gh auth login --hostname ${hostname}` : "gh auth login";
}

function repoSelector(repo: string, hostname: string): string {
  return hostname && hostname !== "github.com" && !repo.startsWith(`${hostname}/`) ? `${hostname}/${repo}` : repo;
}

function ghList(
  kind: "pr" | "issue",
  repo: string,
  limit: number,
  state: string,
  retries: number,
  retryDelayMs: number,
  writeStderr: (message: string) => void,
): Promise<unknown> {
  const fields = kind === "pr" ? PR_LIST_FIELDS : ISSUE_LIST_FIELDS;
  return runGh([kind, "list", "--repo", repo, "--limit", String(limit), "--state", state, "--json", fields], retries, retryDelayMs, writeStderr);
}

async function ghView(
  kind: "pr" | "issue",
  repo: string,
  number: number,
  retries: number,
  retryDelayMs: number,
  writeStderr: (message: string) => void,
): Promise<JsonObject> {
  const fields = kind === "pr" ? PR_VIEW_FIELDS : ISSUE_VIEW_FIELDS;
  const value = await runGh([kind, "view", String(number), "--repo", repo, "--json", fields], retries, retryDelayMs, writeStderr);
  if (!isObject(value)) throw new RepoMemoryError(`gh ${kind} view response was not a JSON object`);
  return value;
}

async function fetchPrFacets(
  queryRepo: string,
  facetRepo: string,
  repoPath: string,
  snapshotSha: string,
  limit: number,
  state: "all" | "open" | "closed",
  concurrency: number,
  summaryChars: number,
  retries: number,
  retryDelayMs: number,
  writeStderr: (message: string) => void,
): Promise<JsonObject[]> {
  if (snapshotSha && state === "open") return [];
  const facets: JsonObject[] = [];
  const seenNumbers = new Set<number>();
  let candidateLimit = Math.max(1, limit);
  let previousCandidateCount = -1;
  while (facets.length < limit) {
    const rawCandidates = await ghList("pr", queryRepo, candidateLimit, state, retries, retryDelayMs, writeStderr);
    if (!Array.isArray(rawCandidates)) throw new RepoMemoryError("gh PR list response was not a JSON list");
    const candidateCount = rawCandidates.length;
    const numbers: number[] = [];
    for (const item of rawCandidates) {
      const number = integerField(item);
      if (number !== undefined && !seenNumbers.has(number)) {
        seenNumbers.add(number);
        numbers.push(number);
      }
    }
    const current = await mapConcurrent(numbers, concurrency, async (number) => {
      const detail = await ghView("pr", queryRepo, number, retries, retryDelayMs, writeStderr);
      if (snapshotSha && !prIsInSnapshot(repoPath, detail, snapshotSha)) return undefined;
      return prDetailToFacet(facetRepo, detail, summaryChars);
    });
    for (const facet of current) {
      if (facet) facets.push(facet);
      if (facets.length >= limit) break;
    }
    if (facets.length >= limit || candidateCount < candidateLimit || candidateCount === previousCandidateCount) break;
    previousCandidateCount = candidateCount;
    candidateLimit *= 2;
  }
  return facets.slice(0, limit);
}

function prIsInSnapshot(repoPath: string, detail: JsonObject, snapshotSha: string): boolean {
  if (!snapshotSha) return true;
  const mergeSha = commitSha(detail.mergeCommit);
  return Boolean(mergeSha) && isGitAncestor(repoPath, mergeSha, snapshotSha);
}

function prDetailToFacet(repo: string, detail: JsonObject, summaryChars: number): JsonObject {
  const number = integerField(detail) ?? 0;
  const title = textField(detail, "title") || `PR #${number}`;
  const body = textField(detail, "body");
  const comments = objectList(detail.comments).map(bodyText).filter(Boolean);
  const reviews = objectList(detail.reviews).map(bodyText).filter(Boolean);
  const commits = uniqueStrings(objectList(detail.commits).map(commitSha).filter(Boolean));
  const headlines = uniqueStrings(objectList(detail.commits).map(commitHeadline).filter(Boolean));
  const files = uniqueStrings(objectList(detail.files).map((item) => textField(item, "path", "filename")).filter(Boolean));
  const reviewStates = uniqueStrings(objectList(detail.latestReviews).map((item) => textField(item, "state")).filter(Boolean));
  const issues = uniqueNumbers(objectList(detail.closingIssuesReferences)
    .map((item) => integerField(item))
    .filter((value): value is number => value !== undefined));
  const summary = boundedSummary([body, ...comments, ...reviews], summaryChars) || title;
  const baseRef = textField(detail, "baseRefName");
  const headRef = textField(detail, "headRefName");
  const headRepo = repositoryName(detail.headRepository) || repo;
  const branchLabel = baseRef || headRef ? `${baseRef} <- ${headRef}` : "";
  const evidence = uniqueStrings([
    `PR #${number}: ${title}`,
    files.length ? `PR #${number} changed ${files.join(", ")}` : "",
    issues.length ? `PR #${number} closes issue ${issues.map((issue) => `#${issue}`).join(", ")}` : "",
  ]);
  return {
    facetId: `pr.${number}`,
    sourceType: "pr",
    repo,
    title,
    summary,
    url: textField(detail, "url"),
    state: textField(detail, "state"),
    createdAt: textField(detail, "createdAt"),
    updatedAt: textField(detail, "updatedAt"),
    closedAt: textField(detail, "closedAt"),
    mergedAt: textField(detail, "mergedAt"),
    author: textField(detail.author, "login", "name"),
    isDraft: Boolean(detail.isDraft),
    base_ref: baseRef,
    head_ref: headRef,
    head_repo: headRepo,
    branch_label: branchLabel,
    changed_files: (typeof detail.changedFiles === "number" ? detail.changedFiles : 0) || files.length,
    additions: (typeof detail.additions === "number" ? detail.additions : 0) || 0,
    deletions: (typeof detail.deletions === "number" ? detail.deletions : 0) || 0,
    commit_headlines: headlines,
    review_decision: textField(detail, "reviewDecision"),
    review_states: reviewStates,
    commits,
    prs: number ? [number] : [],
    issues,
    files,
    symbols: extractSymbols([title, summary, ...files].join("\n")),
    evidence,
  };
}

function issueDetailToFacet(repo: string, detail: JsonObject, summaryChars: number): JsonObject {
  const number = integerField(detail) ?? 0;
  const title = textField(detail, "title") || `Issue #${number}`;
  const body = textField(detail, "body");
  const comments = objectList(detail.comments).map(bodyText).filter(Boolean);
  const labels = objectList(detail.labels).map((item) => textField(item, "name")).filter(Boolean);
  const labelsText = labels.length ? `Labels: ${labels.join(", ")}` : "";
  const summary = boundedSummary([body, ...comments, labelsText], summaryChars) || title;
  const evidence = uniqueStrings([
    `issue #${number}: ${title}`,
    labels.length ? `issue #${number} labels: ${labels.join(", ")}` : "",
  ]);
  return {
    facetId: `issue.${number}`,
    sourceType: "issue",
    repo,
    title,
    summary,
    url: textField(detail, "url"),
    state: textField(detail, "state"),
    updatedAt: textField(detail, "updatedAt"),
    labels,
    commits: [],
    prs: [],
    issues: number ? [number] : [],
    files: [],
    symbols: extractSymbols([title, summary, ...labels].join("\n")),
    evidence,
  };
}

function repositoryName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isObject(value)) return "";
  const nameWithOwner = textField(value, "nameWithOwner");
  if (nameWithOwner.includes("/")) return nameWithOwner;
  const owner = textField(value.owner, "login");
  const name = textField(value, "name", "nameWithOwner");
  return owner && name ? `${owner}/${name}` : name;
}

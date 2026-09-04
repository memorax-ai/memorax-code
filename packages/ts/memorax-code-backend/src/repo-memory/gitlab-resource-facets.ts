import { writeFileSync } from "node:fs";
import {
  assertRange,
  canonicalPath,
  commandAvailable,
  commandOutput,
  delay,
  failedOutput,
  parseInteger,
  RepoMemoryError,
  requiredValue,
  runCommand,
  runCommandAsync,
  type CommandOutput,
} from "./shared.js";
import {
  boundedSummary,
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

const DEFAULT_GLAB_RETRIES = 3;
const DEFAULT_GLAB_RETRY_DELAY_MS = 1000;
const TRANSIENT_GLAB_ERROR = /EOF|timeout|timed out|connection reset|connection refused|temporarily unavailable|TLS handshake timeout|502|503|504|rate limit|too many requests/i;

export interface GitlabFacetOptions {
  repo: string;
  hostname: string;
  repoPath: string;
  snapshotRef: string;
  prLimit: number;
  issueLimit: number;
  state: "all" | "open" | "closed";
  include: Set<"prs" | "issues">;
  summaryChars: number;
  retries: number;
  retryDelayMs: number;
}

export async function fetchGitlabFacets(
  options: GitlabFacetOptions,
  writeStderr: (message: string) => void = (message) => process.stderr.write(message),
): Promise<JsonObject[]> {
  await assertGlabReady(options.hostname, writeStderr);
  const repoPath = canonicalPath(options.repoPath);
  const apiState = stateParam(options.state);
  const snapshotSha = options.snapshotRef && options.include.has("prs")
    ? resolveSnapshotSha(repoPath, options.snapshotRef, "MR")
    : "";
  const facets: JsonObject[] = [];
  if (options.include.has("prs")) {
    facets.push(...await fetchMrFacets(
      options.repo,
      repoPath,
      options.hostname,
      apiState,
      snapshotSha,
      options.prLimit,
      options.summaryChars,
      options.retries,
      options.retryDelayMs,
      writeStderr,
    ));
  }
  if (options.include.has("issues")) {
    const issues = await runGlabApi(apiPath(options.repo, "issues", {
      state: apiState,
      per_page: options.issueLimit,
      order_by: "updated_at",
      sort: "desc",
    }), options.hostname, options.retries, options.retryDelayMs, writeStderr);
    if (!Array.isArray(issues)) throw new RepoMemoryError("glab issue list response was not a JSON list");
    facets.push(...objectList(issues).map((item) => issueToFacet(options.repo, item, options.summaryChars)));
  }
  return facets;
}

export async function executeGitlabFacets(args: string[]): Promise<CommandOutput> {
  try {
    const parsed = parseGitlabArgs(args);
    if (parsed.help) return { exitCode: 0, stdout: `${gitlabFacetsUsage()}\n`, stderr: "" };
    let stderr = "";
    const facets = await fetchGitlabFacets(parsed.options, (message) => { stderr += message; });
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

export function gitlabFacetsUsage(): string {
  return "Usage: memorax-code repo-memory gitlab-facets --repo GROUP/PROJECT [options]";
}

function parseGitlabArgs(args: string[]): {
  options: GitlabFacetOptions;
  pretty: boolean;
  out?: string;
  help?: boolean;
} {
  const options: GitlabFacetOptions = {
    repo: "",
    hostname: "",
    repoPath: ".",
    snapshotRef: "",
    prLimit: 30,
    issueLimit: 30,
    state: "all",
    include: new Set(["prs", "issues"]),
    summaryChars: 4000,
    retries: DEFAULT_GLAB_RETRIES,
    retryDelayMs: DEFAULT_GLAB_RETRY_DELAY_MS,
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
    else if (value === "--glab-retries") options.retries = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--glab-retry-delay-ms") options.retryDelayMs = parseInteger(requiredValue(args, index++, value), value);
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
  if (!options.repo.includes("/")) throw new RepoMemoryError("--repo must be group/project or group/subgroup/project", 2);
  assertRange("--pr-limit", options.prLimit, 1, 100);
  assertRange("--issue-limit", options.issueLimit, 1, 100);
  assertRange("--glab-retries", options.retries, 0, 10);
  if (options.retryDelayMs < 0) throw new RepoMemoryError("--glab-retry-delay-ms must be non-negative", 2);
  if (options.summaryChars < 100) throw new RepoMemoryError("--summary-chars must be at least 100", 2);
  return { options, pretty, ...(out ? { out } : {}) };
}

async function runGlabApi(
  path: string,
  hostname: string,
  retries: number,
  retryDelayMs: number,
  writeStderr: (message: string) => void,
): Promise<unknown> {
  if (!commandAvailable("glab")) throw new RepoMemoryError("GitLab CLI 'glab' is required. Install it and run: glab auth login");
  const args = ["api", ...(hostname ? ["--hostname", hostname] : []), path];
  const attempts = Math.max(1, retries + 1);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runCommandAsync("glab", args, { cwd: process.cwd() });
    last = result;
    if (result.status === 0) {
      const text = result.stdout.trim();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new RepoMemoryError(`glab api ${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (attempt < attempts && TRANSIENT_GLAB_ERROR.test(`${result.stderr}\n${result.stdout}`)) {
      const delayMs = Math.max(0, retryDelayMs) * (2 ** (attempt - 1));
      writeStderr(`glab api ${path} failed with transient error; retrying ${attempt}/${retries} after ${(delayMs / 1000).toFixed(1)}s: ${result.stderr.trim()}\n`);
      await delay(delayMs);
      continue;
    }
    break;
  }
  throw new RepoMemoryError(`glab api ${path} failed:\n${last?.stderr.trim() ?? ""}`);
}

async function assertGlabReady(hostname: string, writeStderr: (message: string) => void): Promise<void> {
  if (!commandAvailable("glab")) throw new RepoMemoryError("GitLab CLI 'glab' is required. Install it and run: glab auth login");
  const args = ["auth", "status", ...(hostname ? ["--hostname", hostname] : [])];
  const attempts = DEFAULT_GLAB_RETRIES + 1;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runCommand("glab", args, { cwd: process.cwd() });
    last = result;
    if (result.status === 0) return;
    if (attempt < attempts && TRANSIENT_GLAB_ERROR.test(`${result.stderr}\n${result.stdout}`)) {
      const delayMs = DEFAULT_GLAB_RETRY_DELAY_MS * (2 ** (attempt - 1));
      writeStderr(`glab auth status failed with transient error; retrying ${attempt}/${DEFAULT_GLAB_RETRIES} after ${(delayMs / 1000).toFixed(1)}s: ${result.stderr.trim()}\n`);
      await delay(delayMs);
      continue;
    }
    break;
  }
  if (!last) throw new RepoMemoryError("glab auth check failed");
  const details = [
    ...(last.stderr.trim() ? [`stderr: ${last.stderr.trim()}`] : []),
    ...(last.stdout.trim() ? [`stdout: ${last.stdout.trim()}`] : []),
  ];
  const detail = details.join("\n") || "glab auth status returned no diagnostic output";
  throw new RepoMemoryError(`glab auth check failed with exit code ${last.status}. Run: ${loginHint(hostname)}\n${detail}`);
}

function loginHint(hostname: string): string {
  return hostname && hostname !== "gitlab.com" ? `glab auth login --hostname ${hostname}` : "glab auth login";
}

function apiPath(repo: string, endpoint: string, parameters?: Record<string, string | number>): string {
  const path = `projects/${encodeURIComponent(repo)}/${endpoint}`;
  if (!parameters) return path;
  const query = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)])).toString();
  return query ? `${path}?${query}` : path;
}

function stateParam(state: string): string {
  return state === "open" ? "opened" : state;
}

function normalizeState(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "opened") return "OPEN";
  if (raw === "merged") return "MERGED";
  if (raw === "closed") return "CLOSED";
  return raw ? raw.toUpperCase() : "";
}

async function fetchMrFacets(
  repo: string,
  repoPath: string,
  hostname: string,
  apiState: string,
  snapshotSha: string,
  limit: number,
  summaryChars: number,
  retries: number,
  retryDelayMs: number,
  writeStderr: (message: string) => void,
): Promise<JsonObject[]> {
  if (snapshotSha && apiState === "opened") return [];
  const facets: JsonObject[] = [];
  if (!snapshotSha) {
    const requests = await runGlabApi(apiPath(repo, "merge_requests", {
      state: apiState,
      per_page: limit,
      order_by: "updated_at",
      sort: "desc",
    }), hostname, retries, retryDelayMs, writeStderr);
    if (!Array.isArray(requests)) throw new RepoMemoryError("glab merge request list response was not a JSON list");
    for (const item of objectList(requests)) {
      const facet = await mrFacet(repo, item, hostname, summaryChars, retries, retryDelayMs, writeStderr);
      if (facet) facets.push(facet);
    }
    return facets.slice(0, limit);
  }
  let page = 1;
  while (facets.length < limit) {
    const requests = await runGlabApi(apiPath(repo, "merge_requests", {
      state: apiState,
      per_page: limit,
      order_by: "updated_at",
      sort: "desc",
      page,
    }), hostname, retries, retryDelayMs, writeStderr);
    if (!Array.isArray(requests)) throw new RepoMemoryError("glab merge request list response was not a JSON list");
    if (!requests.length) break;
    for (const item of objectList(requests)) {
      if (!mrIsInSnapshot(repoPath, item, snapshotSha)) continue;
      const facet = await mrFacet(repo, item, hostname, summaryChars, retries, retryDelayMs, writeStderr);
      if (facet) facets.push(facet);
      if (facets.length >= limit) break;
    }
    if (facets.length >= limit || requests.length < limit) break;
    page += 1;
  }
  return facets.slice(0, limit);
}

async function mrFacet(
  repo: string,
  item: JsonObject,
  hostname: string,
  summaryChars: number,
  retries: number,
  retryDelayMs: number,
  writeStderr: (message: string) => void,
): Promise<JsonObject | undefined> {
  const number = integerField(item, "iid", true);
  if (!number) return undefined;
  const changes = await runGlabApi(apiPath(repo, `merge_requests/${number}/changes`), hostname, retries, retryDelayMs, writeStderr);
  return mrToFacet(repo, item, isObject(changes) ? changes : {}, summaryChars);
}

function mrIsInSnapshot(repoPath: string, detail: JsonObject, snapshotSha: string): boolean {
  if (!snapshotSha) return true;
  const mergeSha = textField(detail, "merge_commit_sha", "squash_commit_sha");
  return Boolean(mergeSha) && isGitAncestor(repoPath, mergeSha, snapshotSha);
}

function mrToFacet(repo: string, detail: JsonObject, changes: JsonObject, summaryChars: number): JsonObject {
  const number = integerField(detail, "iid", true) ?? 0;
  const title = textField(detail, "title") || `MR !${number}`;
  const description = textField(detail, "description");
  const files = changePaths(changes);
  const summary = boundedSummary([description], summaryChars) || title;
  const baseRef = textField(detail, "target_branch");
  const headRef = textField(detail, "source_branch");
  const branchLabel = baseRef || headRef ? `${baseRef} <- ${headRef}` : "";
  const issues = linkedIssueNumbers(description);
  const mergeSha = textField(detail, "merge_commit_sha", "squash_commit_sha");
  const evidence = uniqueStrings([
    `MR !${number}: ${title}`,
    files.length ? `MR !${number} changed ${files.join(", ")}` : "",
    issues.length ? `MR !${number} closes issue ${issues.map((issue) => `#${issue}`).join(", ")}` : "",
  ]);
  return {
    facetId: `mr.${number}`,
    sourceType: "pr",
    provider: "gitlab",
    repo,
    title,
    summary,
    url: textField(detail, "web_url", "url"),
    state: normalizeState(detail.state),
    createdAt: textField(detail, "created_at"),
    updatedAt: textField(detail, "updated_at"),
    closedAt: textField(detail, "closed_at"),
    mergedAt: textField(detail, "merged_at"),
    author: textField(detail.author, "username", "login", "name"),
    isDraft: Boolean(detail.draft || detail.work_in_progress),
    base_ref: baseRef,
    head_ref: headRef,
    head_repo: repo,
    branch_label: branchLabel,
    changed_files: integerField(detail, "changes_count", true) || files.length,
    additions: 0,
    deletions: 0,
    commit_headlines: [],
    review_decision: "",
    review_states: [],
    commits: mergeSha ? [mergeSha] : [],
    merge_commit: mergeSha,
    prs: number ? [number] : [],
    issues,
    files,
    symbols: extractSymbols([title, summary, ...files].join("\n")),
    evidence,
  };
}

function issueToFacet(repo: string, detail: JsonObject, summaryChars: number): JsonObject {
  const number = integerField(detail, "iid", true) ?? 0;
  const title = textField(detail, "title") || `Issue #${number}`;
  const description = textField(detail, "description");
  const labels = labelNames(detail.labels);
  const labelsText = labels.length ? `Labels: ${labels.join(", ")}` : "";
  const summary = boundedSummary([description, labelsText], summaryChars) || title;
  const evidence = uniqueStrings([
    `issue #${number}: ${title}`,
    labels.length ? `issue #${number} labels: ${labels.join(", ")}` : "",
  ]);
  return {
    facetId: `issue.${number}`,
    sourceType: "issue",
    provider: "gitlab",
    repo,
    title,
    summary,
    url: textField(detail, "web_url", "url"),
    state: normalizeState(detail.state),
    updatedAt: textField(detail, "updated_at"),
    labels,
    commits: [],
    prs: [],
    issues: number ? [number] : [],
    files: [],
    symbols: extractSymbols([title, summary, ...labels].join("\n")),
    evidence,
  };
}

function linkedIssueNumbers(text: string): number[] {
  return uniqueNumbers([...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((match) => Number(match[1])));
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((item) => isObject(item) ? textField(item, "name") : String(item).trim()));
}

function changePaths(value: JsonObject): string[] {
  return uniqueStrings(objectList(value.changes).map((item) => textField(item, "new_path", "old_path")).filter(Boolean));
}

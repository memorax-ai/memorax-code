import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchGithubFacets, type GithubFacetOptions } from "./github-resource-facets.js";
import { fetchGitlabFacets, type GitlabFacetOptions } from "./gitlab-resource-facets.js";
import { parseCodeHostRepo, parseRemoteUrl } from "./prepare.js";
import {
  assertRange,
  canonicalPath,
  commandAvailable,
  failedOutput,
  jsonText,
  parseInteger,
  readJsonError,
  RepoMemoryError,
  requiredValue,
  runCommand,
  type CommandOutput,
  type RepoMemoryContext,
} from "./shared.js";
import { integerField, isObject, type JsonObject } from "./provider-shared.js";

const HISTORY_MODES = new Set(["none", "commits-only", "local-only", "provider", "provider-required"]);
const FALLBACK_DEFAULTS = {
  repoHistory: { mode: "provider", limits: { prs: 30, issues: 30 } },
  limits: { prs: 30, issues: 30 },
  summaryChars: 4000,
};
const AUTHORING_FACET_KEYS = [
  "summary",
  "labels",
  "commits",
  "commit_headlines",
  "review_decision",
  "review_states",
  "files",
  "symbols",
  "evidence",
  "changed_files",
  "additions",
  "deletions",
];

interface DetectOptions {
  repoPath: string;
  memoryPath?: string;
  snapshotRef: string;
  historyMode?: string;
  providerMode: "auto" | "off";
  prLimit?: number;
  issueLimit?: number;
  summaryChars?: number;
  pretty: boolean;
}

interface EffectiveDetectOptions extends DetectOptions {
  historyMode: string;
  historyCollect: { commits: boolean; provider: boolean };
  prLimit: number;
  issueLimit: number;
  summaryChars: number;
  effectiveSettings: Record<string, unknown>;
}

interface ProviderReport extends JsonObject {
  name: string;
  repo: string;
  host: string;
  remote_url: string;
  remote_name: string;
  selection_reason: string;
  evidence_state: string;
  cli: string;
  cli_available: boolean;
  login_hint: string;
}

export async function executeDetectUpdates(args: string[], context: RepoMemoryContext): Promise<CommandOutput> {
  try {
    const parsed = parseDetectArgs(args);
    if (parsed === "help") return { exitCode: 0, stdout: `${detectUpdatesUsage()}\n`, stderr: "" };
    const options = applyEffectiveSettings(parsed, context.skillDir);
    return await detectUpdates(options, context.skillDir);
  } catch (error) {
    return failedOutput(error);
  }
}

export function detectUpdatesUsage(): string {
  return "Usage: memorax-code repo-memory detect-updates [--repo-path PATH] [--memory-path PATH] [--snapshot-ref REF] [history options] [--pretty]";
}

async function detectUpdates(options: EffectiveDetectOptions, skillDir: string): Promise<CommandOutput> {
  const repo = canonicalPath(options.repoPath);
  const memory = options.memoryPath ? canonicalPath(options.memoryPath) : join(repo, ".repo_memory");
  const helpers = builderHelperReport(skillDir);
  if (!existsSync(memory) || !existsSync(join(memory, "PROFILE.md"))) {
    return {
      exitCode: 1,
      stdout: jsonText({
        ok: false,
        repo_path: repo,
        memory_path: memory,
        builder_helpers: helpers,
        error: "Existing .repo_memory/PROFILE.md is required; run $memorax-code repo-build before repo-update.",
      }, options.pretty),
      stderr: "",
    };
  }

  const head = git(repo, ["rev-parse", "--verify", `${options.snapshotRef}^{commit}`], `git could not resolve '${options.snapshotRef}'`);
  const baselineSha = commitBaseline(memory, repo, head);
  let localCommits: JsonObject[];
  let localCommitStatus: JsonObject;
  if (options.historyCollect.commits) {
    [localCommits, localCommitStatus] = commitDelta(repo, baselineSha, head);
  } else {
    localCommits = [];
    localCommitStatus = {
      status: "skipped",
      reason: "history_disabled_by_policy",
      message: "Local commit delta detection is disabled by repoHistory.mode.",
    };
  }

  const existingPrs = baselineItems(memory, "prs.md", "pr");
  const existingIssues = baselineItems(memory, "issues.md", "issue");
  const provider = providerReport(repo, memory, options.historyCollect.provider);
  let providerFetch: JsonObject;
  let currentPrs: JsonObject[];
  let currentIssues: JsonObject[];
  if (options.historyCollect.provider) {
    [providerFetch, currentPrs, currentIssues] = await fetchProviderItems(
      repo,
      provider,
      options.snapshotRef,
      options.prLimit,
      options.issueLimit,
      options.summaryChars,
      skillDir,
    );
  } else {
    const reason = options.providerMode === "off"
      ? "provider-mode=off"
      : options.historyMode === "none"
        ? "history_disabled_by_policy"
        : "history_provider_disabled_by_policy";
    providerFetch = { attempted: false, reason };
    currentPrs = [];
    currentIssues = [];
  }
  const fetchedPrs = providerFetch.ok === true ? currentPrs : [];
  const fetchedIssues = providerFetch.ok === true ? currentIssues : [];
  if (!currentPrs.length && providerFetch.ok !== true) currentPrs = existingPrs;
  if (!currentIssues.length && providerFetch.ok !== true) currentIssues = existingIssues;

  const deltas: JsonObject = {
    local_commits: localCommits,
    local_commit_status: localCommitStatus,
    pull_requests: deltaSummary(existingPrs, currentPrs),
    issues: deltaSummary(existingIssues, currentIssues),
  };
  if (localCommitStatus.status === "skipped" && localCommitStatus.reason) {
    deltas.commit_delta_skipped = localCommitStatus.reason;
  }
  const pullRequestDelta = deltas.pull_requests as JsonObject;
  const issueDelta = deltas.issues as JsonObject;
  const report = {
    ok: true,
    repo_path: repo,
    memory_path: memory,
    effective_settings: options.effectiveSettings,
    builder_helpers: helpers,
    baseline: {
      local_commit_sha: baselineSha,
      pull_request_numbers: pullRequestDelta.baseline_numbers,
      issue_numbers: issueDelta.baseline_numbers,
    },
    current: {
      local_head: head,
      provider,
      provider_fetch: providerFetch,
      provider_items: { pull_requests: fetchedPrs, issues: fetchedIssues },
    },
    deltas,
    notices: noticesFor(deltas, providerFetch),
    actions: actionsFor(deltas, providerFetch),
  };
  return { exitCode: 0, stdout: jsonText(report, options.pretty), stderr: "" };
}

function parseDetectArgs(args: string[]): DetectOptions | "help" {
  const options: DetectOptions = {
    repoPath: ".",
    snapshotRef: "HEAD",
    providerMode: "auto",
    pretty: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--repo-path") options.repoPath = requiredValue(args, index++, value);
    else if (value === "--memory-path") options.memoryPath = requiredValue(args, index++, value);
    else if (value === "--snapshot-ref") options.snapshotRef = requiredValue(args, index++, value);
    else if (value === "--history-mode") options.historyMode = requiredValue(args, index++, value);
    else if (value === "--provider-mode") {
      const mode = requiredValue(args, index++, value);
      if (mode !== "auto" && mode !== "off") throw new RepoMemoryError("--provider-mode must be auto or off", 2);
      options.providerMode = mode;
    } else if (value === "--pr-limit") options.prLimit = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--issue-limit") options.issueLimit = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--summary-chars") options.summaryChars = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--pretty") options.pretty = true;
    else if (value === "--help" || value === "-h") return "help";
    else throw new RepoMemoryError(`unrecognized arguments: ${value}`, 2);
  }
  if (options.historyMode && !HISTORY_MODES.has(options.historyMode)) {
    throw new RepoMemoryError(`--history-mode must be one of ${[...HISTORY_MODES].sort().join(", ")}`, 2);
  }
  return options;
}

function applyEffectiveSettings(options: DetectOptions, skillDir: string): EffectiveDetectOptions {
  const defaultsPath = join(skillDir, "defaults.json");
  const { settings, source } = loadDefaultSettings(defaultsPath);
  const historyMode = options.historyMode ?? defaultHistoryMode(settings, defaultsPath);
  let historyCollect = historyCollectFor(historyMode);
  if (options.providerMode === "off") {
    if (historyMode === "provider-required") {
      throw new RepoMemoryError("--provider-mode off cannot be combined with --history-mode provider-required", 2);
    }
    historyCollect = { ...historyCollect, provider: false };
  }
  const prLimit = options.prLimit ?? defaultLimit(settings, "prs", defaultsPath);
  const issueLimit = options.issueLimit ?? defaultLimit(settings, "issues", defaultsPath);
  const summaryChars = options.summaryChars ?? defaultInteger(settings, ["summaryChars"], FALLBACK_DEFAULTS.summaryChars, defaultsPath);
  assertRange("--pr-limit", prLimit, 1, 100);
  assertRange("--issue-limit", issueLimit, 1, 100);
  if (summaryChars < 100) throw new RepoMemoryError("--summary-chars must be at least 100", 2);
  const overrides: Record<string, unknown> = {};
  if (options.historyMode !== undefined) overrides.history_mode = options.historyMode;
  if (options.prLimit !== undefined) overrides.pr_limit = options.prLimit;
  if (options.issueLimit !== undefined) overrides.issue_limit = options.issueLimit;
  if (options.summaryChars !== undefined) overrides.summary_chars = options.summaryChars;
  return {
    ...options,
    historyMode,
    historyCollect,
    prLimit,
    issueLimit,
    summaryChars,
    effectiveSettings: {
      history: { mode: historyMode, collect: historyCollect },
      limits: { prs: prLimit, issues: issueLimit },
      summary_chars: summaryChars,
      source,
      overrides,
    },
  };
}

function historyCollectFor(mode: string): { commits: boolean; provider: boolean } {
  return {
    commits: mode === "commits-only" || mode === "local-only" || mode === "provider" || mode === "provider-required",
    provider: mode === "provider" || mode === "provider-required",
  };
}

function loadDefaultSettings(path: string): { settings: JsonObject; source: string } {
  if (!existsSync(path)) return { settings: FALLBACK_DEFAULTS, source: "hardcoded_fallback" };
  const value = loadJson(path, FALLBACK_DEFAULTS);
  if (!isObject(value)) throw new RepoMemoryError(`${path}: expected a JSON object`, 2);
  return { settings: value, source: path };
}

function defaultHistoryMode(settings: JsonObject, path: string): string {
  const history = isObject(settings.repoHistory) ? settings.repoHistory : undefined;
  if (!history) return "provider";
  const mode = history.mode ?? "provider";
  if (typeof mode !== "string" || !HISTORY_MODES.has(mode)) {
    throw new RepoMemoryError(`${path}: repoHistory.mode must be one of ${[...HISTORY_MODES].sort().join(", ")}`, 2);
  }
  return mode;
}

function defaultLimit(settings: JsonObject, key: "prs" | "issues", path: string): number {
  const history = isObject(settings.repoHistory) ? settings.repoHistory : undefined;
  const limits = history && isObject(history.limits) ? history.limits : undefined;
  if (limits?.[key] !== undefined) return defaultInteger(settings, ["repoHistory", "limits", key], FALLBACK_DEFAULTS.repoHistory.limits[key], path);
  return defaultInteger(settings, ["limits", key], FALLBACK_DEFAULTS.limits[key], path);
}

function defaultInteger(settings: JsonObject, keys: string[], fallback: number, path: string): number {
  let value: unknown = settings;
  for (const key of keys) value = isObject(value) ? value[key] : undefined;
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw new RepoMemoryError(`${path}: ${keys.join(".")} must be an integer`, 2);
  return value as number;
}

function builderHelperReport(skillDir: string): JsonObject {
  const scriptsDir = join(skillDir, "scripts");
  const runtime = join(scriptsDir, "repo-memory.mjs");
  return {
    skill_dir: skillDir,
    scripts_dir: scriptsDir,
    files: {
      defaults: fileFingerprint(join(skillDir, "defaults.json")),
      validate_memory: fileFingerprint(runtime),
      github_resource_facets: fileFingerprint(runtime),
      gitlab_resource_facets: fileFingerprint(runtime),
    },
  };
}

function fileFingerprint(path: string): JsonObject {
  const item: JsonObject = { path, exists: existsSync(path) };
  if (existsSync(path)) {
    const metadata = statSync(path, { bigint: true });
    item.mtime_ns = Number(metadata.mtimeNs);
    item.size_bytes = Number(metadata.size);
  }
  return item;
}

function loadJson(path: string, fallback: unknown): unknown {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RepoMemoryError(`${path}: invalid JSON at ${readJsonError(error, text)}`);
  }
}

function parseFrontmatter(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    value = value.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
    if (key) fields[key] = value;
  }
  return fields;
}

function bodyAfterFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\n+/, "");
}

function commitBaseline(memory: string, repo: string, headSha: string): string {
  const profileHead = parseFrontmatter(join(memory, "PROFILE.md")).local_head ?? "";
  if (profileHead) return profileHead;
  const resourcePath = join(memory, "resources", "commits.md");
  if (!existsSync(resourcePath)) return "";
  const text = bodyAfterFrontmatter(readFileSync(resourcePath, "utf8"));
  const shas = [...text.matchAll(/^\s*-\s*SHA:\s*`?([0-9a-f]{7,40})`?/gim)].map((match) => match[1]);
  if (shas.length) {
    const nearest = nearestAncestor(repo, shas, headSha);
    return nearest || shas[0];
  }
  return "";
}

function nearestAncestor(repo: string, candidates: string[], descendant: string): string {
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  if (!uniqueCandidates.length) return "";
  const result = runCommand("git", ["-C", repo, "rev-list", descendant], { cwd: repo });
  if (result.status !== 0) return "";
  for (const sha of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const candidate = uniqueCandidates.find((value) => sha.startsWith(value));
    if (candidate) return candidate;
  }
  return "";
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  if (!ancestor) return false;
  return runCommand("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo }).status === 0;
}

function git(repo: string, args: string[], message: string): string {
  if (!commandAvailable("git")) throw new RepoMemoryError("git is required for repo-memory incremental update detection");
  const result = runCommand("git", ["-C", repo, ...args], { cwd: repo });
  if (result.status !== 0) throw new RepoMemoryError(`${message}:\n${result.stderr.trim()}`);
  return result.stdout.trim();
}

function commitDelta(repo: string, baselineSha: string, headSha: string): [JsonObject[], JsonObject] {
  if (!baselineSha) {
    return [[], {
      status: "skipped",
      reason: "missing_baseline_commit",
      message: "No stored local commit baseline was found in .repo_memory.",
    }];
  }
  if (baselineSha === headSha) return [[], { status: "current", reason: "" }];
  if (!isAncestor(repo, baselineSha, headSha)) {
    return [[], {
      status: "skipped",
      reason: "baseline_not_ancestor_of_head",
      message: "Stored repo-memory commit baseline is not an ancestor of the current HEAD; history was probably rebased or force-pushed.",
    }];
  }
  const shas = git(repo, ["rev-list", "--reverse", `${baselineSha}..${headSha}`], "git could not list new commits")
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const commits = shas.map((sha) => {
    const fields = git(repo, ["show", "-s", "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s", sha], `git could not read commit ${sha}`).split("\x1f");
    while (fields.length < 5) fields.push("");
    const files = git(repo, ["show", "--format=", "--name-only", "--no-renames", sha], `git could not list files for ${sha}`)
      .split(/\r?\n/).filter(Boolean);
    return {
      sha: fields[0],
      short_sha: fields[1],
      title: fields[4],
      author: fields[2],
      authored_at: fields[3],
      files,
    };
  });
  return [commits, { status: "ok", reason: "", count: commits.length }];
}

function markdownSections(path: string): Array<[string, string]> {
  if (!existsSync(path)) return [];
  const text = bodyAfterFrontmatter(readFileSync(path, "utf8"));
  const matches = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return [match[1].trim(), text.slice(start, end)];
  });
}

function markdownField(body: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*-\\s*${escaped}:\\s*(.+?)\\s*$`, "im").exec(body);
  return match ? match[1].trim().replace(/^`+|`+$/g, "").trim() : "";
}

function firstCodeValue(text: string): string {
  const match = /`([^`]+)`/.exec(text);
  return match ? match[1].trim() : text.trim();
}

function resourceItems(memory: string, resourceName: string): JsonObject[] {
  const kind = resourceName === "issues.md" ? "issue" : "pr";
  const output: JsonObject[] = [];
  for (const [title, body] of markdownSections(join(memory, "resources", resourceName))) {
    const numberMatch = /[#!#]\s*(\d+)/.exec(title);
    if (!numberMatch) continue;
    const item: JsonObject = {
      number: Number(numberMatch[1]),
      title: title.includes(":") ? title.split(":", 2)[1].trim() : title.trim(),
      source: "resource",
    };
    const state = firstCodeValue(markdownField(body, "State"));
    const url = markdownField(body, "URL");
    if (state) item.state = state;
    if (url) item.url = url;
    if (kind === "pr") {
      const branch = firstCodeValue(markdownField(body, "Branch"));
      if (branch.includes("<-")) {
        const [base, head] = branch.split("<-", 2).map((value) => value.trim());
        if (base) item.base_ref = base;
        if (head) item.head_ref = head;
      }
    }
    output.push(item);
  }
  return output;
}

function facetNumber(facet: JsonObject, sourceType: string): number | undefined {
  const values = sourceType === "issue" ? facet.issues : facet.prs;
  if (typeof values === "number" && Number.isInteger(values)) return values;
  if (Array.isArray(values)) {
    const value = values.find((item) => typeof item === "number" && Number.isInteger(item));
    if (typeof value === "number") return value;
  }
  const match = /\.(\d+)$/.exec(String(facet.facetId ?? ""));
  return match ? Number(match[1]) : undefined;
}

function keepValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function facetItems(facets: unknown, sourceType: "pr" | "issue"): JsonObject[] {
  if (!Array.isArray(facets)) return [];
  const output: JsonObject[] = [];
  for (const value of facets) {
    if (!isObject(value) || value.sourceType !== sourceType) continue;
    const number = facetNumber(value, sourceType);
    if (number === undefined) continue;
    const item: JsonObject = {
      number,
      title: String(value.title || ""),
      state: String(value.state || ""),
      updated_at: String(value.updatedAt || value.updated_at || ""),
      url: String(value.url || ""),
      source: "provider_facet",
    };
    const facetId = String(value.facetId || "");
    if (facetId) item.raw_lookup = `facetId=${facetId}`;
    for (const key of AUTHORING_FACET_KEYS) if (key in value) item[key] = value[key];
    if (sourceType === "pr") {
      item.base_ref = String(value.base_ref || "");
      item.head_ref = String(value.head_ref || "");
      item.merged_at = String(value.mergedAt || value.merged_at || "");
      item.closed_at = String(value.closedAt || value.closed_at || "");
      if (keepValue(value.issues)) item.linked_issues = value.issues;
    }
    output.push(Object.fromEntries(Object.entries(item).filter(([, itemValue]) => keepValue(itemValue))));
  }
  return output;
}

function rawProviderItems(memory: string, sourceType: "pr" | "issue"): JsonObject[] {
  const output: JsonObject[] = [];
  for (const name of ["github-facets.json", "gitlab-facets.json"]) {
    const path = join(memory, "raw", name);
    if (existsSync(path)) output.push(...facetItems(loadJson(path, []), sourceType));
  }
  return output;
}

function baselineItems(memory: string, resourceName: string, sourceType: "pr" | "issue"): JsonObject[] {
  const resource = resourceItems(memory, resourceName);
  const rawByNumber = byNumber(rawProviderItems(memory, sourceType));
  const output: JsonObject[] = [];
  const seen = new Set<number>();
  for (const item of resource) {
    const number = itemNumber(item);
    if (number === undefined) continue;
    const raw = rawByNumber.get(number);
    output.push({ ...item, ...(raw ?? {}), ...(raw ? { source: "resource_with_raw_provider_facet" } : {}) });
    seen.add(number);
  }
  for (const [number, item] of [...rawByNumber.entries()].sort(([left], [right]) => left - right)) {
    if (!seen.has(number)) output.push(item);
  }
  return output;
}

function itemNumber(item: JsonObject): number | undefined {
  return typeof item.number === "number" && Number.isInteger(item.number) ? item.number : undefined;
}

function byNumber(items: JsonObject[]): Map<number, JsonObject> {
  const output = new Map<number, JsonObject>();
  for (const item of items) {
    const number = itemNumber(item);
    if (number !== undefined) output.set(number, item);
  }
  return output;
}

function changedNumbers(existing: Map<number, JsonObject>, current: Map<number, JsonObject>): number[] {
  const changed: number[] = [];
  for (const [number, item] of current) {
    const old = existing.get(number);
    if (!old) continue;
    let found = false;
    for (const key of ["updated_at", "state", "title", "head_ref", "base_ref", "merged_at", "closed_at"]) {
      if (keepValue(old[key]) && old[key] !== item[key]) {
        changed.push(number);
        found = true;
        break;
      }
    }
    if (found) continue;
    const commonKeys = Object.entries(old)
      .filter(([key, value]) => !["number", "raw_lookup", "source"].includes(key) && keepValue(value))
      .map(([key]) => key);
    const oldCommon = Object.fromEntries(commonKeys.map((key) => [key, old[key]]));
    const currentCommon = Object.fromEntries(commonKeys.map((key) => [key, item[key]]));
    if (stableJson(oldCommon) !== stableJson(currentCommon) && comparableItem(old) !== comparableItem(item)) changed.push(number);
  }
  return changed.sort((left, right) => left - right);
}

function comparableItem(item: JsonObject): string {
  return stableJson(Object.fromEntries(Object.entries(item).filter(([key]) => !["raw_lookup", "source", "updated_at", "merged_at", "closed_at"].includes(key))));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function providerReport(repo: string, memory: string, inspectCli: boolean): ProviderReport {
  const profile = providerFromProfile(memory);
  const remote = profile ?? parseCodeHostRepo(git(repo, ["remote", "-v"], "git could not list remotes"));
  const provider = remote.provider;
  const cli = provider === "github" ? "gh" : provider === "gitlab" ? "glab" : "";
  let evidenceState = inspectCli ? "unavailable" : "skipped_by_policy";
  let cliAvailable = false;
  if (cli && inspectCli) [evidenceState, cliAvailable] = cliEvidenceState(cli, remote.host);
  return {
    name: provider,
    repo: remote.repo,
    host: remote.host,
    remote_url: remote.url,
    remote_name: remote.remote_name,
    selection_reason: remote.selection_reason,
    evidence_state: evidenceState,
    cli,
    cli_available: cliAvailable,
    login_hint: cli ? loginHint(cli, remote.host) : "",
  };
}

function providerFromProfile(memory: string): ReturnType<typeof parseCodeHostRepo> | undefined {
  const profile = parseFrontmatter(join(memory, "PROFILE.md"));
  const provider = profile.code_host_provider ?? "";
  const repo = profile.repo_full_name ?? "";
  if ((provider !== "github" && provider !== "gitlab") || !repo.includes("/")) return undefined;
  const parsed = parseRemoteUrl(profile.repo_url ?? "");
  const host = parsed.provider === provider ? parsed.host : provider === "github" ? "github.com" : "gitlab.com";
  return {
    provider,
    repo,
    host,
    url: profile.repo_url ?? "",
    remote_name: "",
    selection_reason: "profile_frontmatter",
  };
}

function cliEvidenceState(command: string, host: string): [string, boolean] {
  if (!commandAvailable(command)) return ["cli_missing", false];
  const args = ["auth", "status", ...(host ? ["--hostname", host] : [])];
  const result = runCommand(command, args, { cwd: process.cwd(), timeoutMs: 8000 });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") return ["auth_check_timeout", true];
  return result.status === 0 ? ["ready", true] : ["auth_required", true];
}

function loginHint(command: string, host: string): string {
  const defaultHost = command === "gh" ? "github.com" : command === "glab" ? "gitlab.com" : "";
  return host && host !== defaultHost ? `${command} auth login --hostname ${host}` : `${command} auth login`;
}

async function fetchProviderItems(
  repo: string,
  provider: ProviderReport,
  snapshotRef: string,
  prLimit: number,
  issueLimit: number,
  summaryChars: number,
  skillDir: string,
): Promise<[JsonObject, JsonObject[], JsonObject[]]> {
  if (!provider.name || !provider.repo || provider.evidence_state !== "ready") {
    return [{ attempted: false, reason: `provider_evidence_state=${provider.evidence_state || "unavailable"}` }, [], []];
  }
  const helper = join(skillDir, "scripts", "repo-memory.mjs");
  if (!existsSync(helper)) return [{ attempted: false, reason: "memorax-code repo-build helpers are missing" }, [], []];
  let stderr = "";
  try {
    const common = {
      repo: provider.repo,
      hostname: provider.host,
      repoPath: repo,
      snapshotRef,
      prLimit,
      issueLimit,
      state: "all" as const,
      include: new Set<"prs" | "issues">(["prs", "issues"]),
      summaryChars,
      retries: 3,
      retryDelayMs: 1000,
    };
    const facets = provider.name === "github"
      ? await fetchGithubFacets({ ...common, concurrency: 3 } satisfies GithubFacetOptions, (message) => { stderr += message; })
      : await fetchGitlabFacets(common satisfies GitlabFacetOptions, (message) => { stderr += message; });
    const prs = facetItems(facets, "pr");
    const issues = facetItems(facets, "issue");
    return [{
      attempted: true,
      ok: true,
      provider: provider.name,
      repo: provider.repo,
      pr_count: prs.length,
      issue_count: issues.length,
    }, prs, issues];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ attempted: true, ok: false, exit_code: 1, stderr: `${stderr}${message}`.trim() }, [], []];
  }
}

function deltaSummary(existing: JsonObject[], current: JsonObject[]): JsonObject {
  const existingByNumber = byNumber(existing);
  const currentByNumber = byNumber(current);
  const added = [...currentByNumber.keys()].filter((number) => !existingByNumber.has(number)).sort((a, b) => a - b);
  const updated = changedNumbers(existingByNumber, currentByNumber);
  const baselineOnly = [...existingByNumber.keys()].filter((number) => !currentByNumber.has(number)).sort((a, b) => a - b);
  return {
    baseline_numbers: [...existingByNumber.keys()].sort((a, b) => a - b),
    current_numbers: [...currentByNumber.keys()].sort((a, b) => a - b),
    added_numbers: added,
    updated_numbers: updated,
    upsert_numbers: [...added, ...updated].sort((a, b) => a - b),
    baseline_only_numbers: baselineOnly,
    delete_numbers: [],
  };
}

function actionsFor(deltas: JsonObject, providerFetch: JsonObject): string[] {
  const actions: string[] = [];
  const status = isObject(deltas.local_commit_status) ? deltas.local_commit_status : {};
  if (status.reason === "missing_baseline_commit") {
    actions.push("Local commit delta was skipped because no stored commit baseline was found. Use $memorax-code repo-build for a full rebuild before doing incremental commit updates.");
  }
  if (status.reason === "baseline_not_ancestor_of_head") {
    actions.push("Local commit delta was skipped because the stored baseline is not an ancestor of HEAD. Use $memorax-code repo-build for a full rebuild, or explicitly choose a new baseline before doing incremental commit updates.");
  }
  if (Array.isArray(deltas.local_commits) && deltas.local_commits.length) {
    actions.push("Update .repo_memory/resources/commits.md with sections for the new local commits; update PROFILE.md local_head and commit snapshot notes only where needed.");
  }
  const prs = isObject(deltas.pull_requests) ? deltas.pull_requests : {};
  const issues = isObject(deltas.issues) ? deltas.issues : {};
  if (hasItems(prs.added_numbers) || hasItems(prs.updated_numbers)) {
    actions.push("Upsert .repo_memory/resources/prs.md sections by PR/MR number for only the added or changed numbers. Preserve baseline-only and unaffected PR/MR sections; do not delete missing numbers by default.");
  }
  if (hasItems(issues.added_numbers) || hasItems(issues.updated_numbers)) {
    actions.push("Upsert .repo_memory/resources/issues.md sections by issue number for only the added or changed numbers. Preserve baseline-only and unaffected issue sections; do not delete missing numbers by default.");
  }
  if (providerFetch.attempted === true && providerFetch.ok === false) {
    actions.push("Provider delta fetch failed; keeping existing PR/issue resources unchanged. Fix provider access and rerun $memorax-code repo-update, or use repo-build for a full provider refresh if needed.");
  }
  if (providerFetch.attempted === false) {
    actions.push("Provider delta fetch was skipped; keep PR/issue resources unchanged unless the user asks to login/install provider CLI or force provider refresh.");
  }
  if (!actions.length) actions.push("No repo-memory content update is needed.");
  return actions;
}

function noticesFor(deltas: JsonObject, providerFetch: JsonObject): JsonObject[] {
  const notices: JsonObject[] = [];
  const status = isObject(deltas.local_commit_status) ? deltas.local_commit_status : {};
  if (status.reason === "missing_baseline_commit") {
    notices.push({
      level: "warning",
      title: "Repo Memory Commit Baseline Missing",
      message: "No stored local commit baseline was found in .repo_memory, so incremental commit detection was skipped.",
      next_steps: ["Run $memorax-code repo-build for a full rebuild before incremental commit updates."],
      render_as: "assistant_message",
    });
  }
  if (status.reason === "baseline_not_ancestor_of_head") {
    notices.push({
      level: "warning",
      title: "Repo Memory Baseline Rewritten",
      message: "Stored repo-memory commit baseline is not an ancestor of the current HEAD. History was probably rebased or force-pushed, so incremental commit detection was skipped.",
      next_steps: ["Run $memorax-code repo-build for a full rebuild, or explicitly choose a new baseline before incremental commit updates."],
      render_as: "assistant_message",
    });
  }
  if (providerFetch.attempted === true && providerFetch.ok === false) {
    notices.push({
      level: "warning",
      title: "Provider Delta Fetch Failed",
      message: "Provider delta fetch failed; keeping existing PR/issue resources unchanged. Fix provider access before rerunning provider deltas.",
      next_steps: [
        "Fix GitHub/GitLab CLI access and rerun $memorax-code repo-update.",
        "Use $memorax-code repo-build for a full provider refresh if a broader rebuild is needed.",
      ],
      render_as: "assistant_message",
    });
  }
  return notices;
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

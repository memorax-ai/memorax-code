import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeGitCommitFacets } from "./git-commit-facets.js";
import { executeGithubFacets } from "./github-resource-facets.js";
import { executeGitlabFacets } from "./gitlab-resource-facets.js";
import { executePrepare } from "./prepare.js";
import {
  assertRange,
  canonicalPath,
  failedOutput,
  jsonText,
  parseInteger,
  readJsonError,
  RepoMemoryError,
  requiredValue,
  type CommandOutput,
  type RepoMemoryContext,
} from "./shared.js";

const HISTORY_MODES = new Set(["none", "commits-only", "local-only", "provider", "provider-required"]);
const FALLBACK_DEFAULTS = {
  repoHistory: { mode: "provider", limits: { commits: 30, prs: 30, issues: 30 } },
  limits: { commits: 30, prs: 30, issues: 30 },
  summaryChars: 4000,
};

interface CollectOptions {
  repoPath: string;
  reuse: boolean;
  snapshotRef: string;
  commitLimit?: number;
  prLimit?: number;
  issueLimit?: number;
  summaryChars?: number;
  historyMode?: string;
  skipProvider: boolean;
  requireProvider: boolean;
  pretty: boolean;
  progress: boolean;
}

interface EffectiveCollectOptions extends CollectOptions {
  commitLimit: number;
  prLimit: number;
  issueLimit: number;
  summaryChars: number;
  historyMode: string;
  historyCollect: { commits: boolean; provider: boolean };
  effectiveSettings: Record<string, unknown>;
}

export async function executeCollectAll(args: string[], context: RepoMemoryContext): Promise<CommandOutput> {
  try {
    const parsed = parseCollectArgs(args);
    if (parsed === "help") return { exitCode: 0, stdout: `${collectAllUsage()}\n`, stderr: "" };
    const options = applyEffectiveSettings(parsed, context.skillDir);
    return await collectAll(options);
  } catch (error) {
    return failedOutput(error);
  }
}

export function collectAllUsage(): string {
  return "Usage: memorax-code repo-memory collect [--repo-path PATH] [--reuse] [--snapshot-ref REF] [history options] [--pretty] [--progress]";
}

async function collectAll(options: EffectiveCollectOptions): Promise<CommandOutput> {
  const repo = canonicalPath(options.repoPath);
  const progress = new ProgressBar(options.progress, 3);
  let stderr = "";
  progress.update(0, "prepare", (line) => { stderr += line; });
  const prepare = executePrepare([repo, ...(options.reuse ? ["--reuse"] : [])]);
  if (prepare.exitCode !== 0) {
    progress.fail(0, "prepare failed", (line) => { stderr += line; });
    return writeFailure("prepare", prepare, options.pretty, { repo }, stderr);
  }
  if (prepare.stderr) stderr += ensureNewline(prepare.stderr);
  progress.update(1, "prepare", (line) => { stderr += line; });

  const memory = join(repo, ".repo_memory");
  const rawDir = join(memory, "raw");
  const prepareReportPath = join(rawDir, "prepare-report.json");
  const prepareData = loadJsonObject(prepareReportPath);
  const notices = providerNotices(prepareData);
  const gitCommitsPath = join(rawDir, "git-commits.json");
  const outputs: Record<string, string> = {
    prepare_report: prepareReportPath,
    git_commits: gitCommitsPath,
  };
  let gitCommits: CommandOutput;
  let gitCommitsStep: Record<string, unknown>;
  if (options.historyCollect.commits) {
    gitCommits = executeGitCommitFacets([
      "--repo-path", repo,
      "--snapshot-ref", options.snapshotRef,
      "--limit", String(options.commitLimit),
      "--summary-chars", String(options.summaryChars),
      "--out", gitCommitsPath,
    ]);
    gitCommitsStep = jsonStep(gitCommits);
    if (gitCommits.exitCode !== 0) {
      progress.fail(1, "git commits failed", (line) => { stderr += line; });
      return writeFailure("git_commits", gitCommits, options.pretty, {
        repo,
        memory,
        steps: { prepare: jsonStep(prepare) },
        outputs,
      }, stderr);
    }
  } else {
    writeFileSync(gitCommitsPath, "[]\n", "utf8");
    gitCommits = { exitCode: 0, stdout: "", stderr: "" };
    gitCommitsStep = {
      ok: true,
      exit_code: 0,
      stdout: "",
      stderr: "",
      skipped: true,
      reason: "history_disabled_by_policy",
    };
  }
  progress.update(2, "git commits", (line) => { stderr += line; });

  const provider = providerReport(prepareData);
  const providerName = String(provider.name ?? "");
  const providerOutput = join(rawDir, providerRawName(providerName));
  let providerFacets: Record<string, unknown>;
  if (!options.historyCollect.provider) {
    const reason = options.skipProvider
      ? "provider_skipped_by_user"
      : options.historyMode === "none"
        ? "history_disabled_by_policy"
        : "history_provider_disabled_by_policy";
    providerFacets = { ok: true, skipped: true, reason, output: "" };
  } else if (provider.evidence_state === "ready" && (providerName === "github" || providerName === "gitlab") && provider.repo) {
    const providerArgs = [
      "--repo", String(provider.repo),
      "--repo-path", repo,
      "--snapshot-ref", options.snapshotRef,
      "--include", "prs,issues",
      "--pr-limit", String(options.prLimit),
      "--issue-limit", String(options.issueLimit),
      "--state", "all",
      "--summary-chars", String(options.summaryChars),
      "--out", providerOutput,
      ...(provider.host ? ["--hostname", String(provider.host)] : []),
    ];
    const providerResult = providerName === "github"
      ? await executeGithubFacets(providerArgs)
      : await executeGitlabFacets(providerArgs);
    providerFacets = { ...jsonStep(providerResult), skipped: false, output: providerOutput };
    if (providerResult.exitCode !== 0) {
      providerFacets.degraded_to_local_only = options.historyMode !== "provider-required";
      providerFacets.reason = "provider_facets_failed";
      providerFacets.output = "";
      if (existsSync(providerOutput)) unlinkSync(providerOutput);
      const notice = providerFailureNotice(provider, providerResult, options.historyMode !== "provider-required");
      if (options.historyMode === "provider-required") {
        progress.fail(2, "provider facets failed", (line) => { stderr += line; });
        return writeFailure("provider_facets", providerResult, options.pretty, {
          repo,
          memory,
          provider,
          steps: { prepare: jsonStep(prepare), git_commits: gitCommitsStep },
          outputs,
          notices: [notice],
          effective_settings: options.effectiveSettings,
        }, stderr);
      }
      notices.push(notice);
    } else {
      outputs.provider_facets = providerOutput;
    }
  } else if (options.historyMode === "provider-required") {
    const providerResult: CommandOutput = {
      exitCode: 1,
      stdout: "",
      stderr: `provider evidence is required but provider_evidence_state=${String(provider.evidence_state ?? "")}\n`,
    };
    progress.fail(2, "provider facets unavailable", (line) => { stderr += line; });
    return writeFailure("provider_facets", providerResult, options.pretty, {
      repo,
      memory,
      provider,
      steps: { prepare: jsonStep(prepare), git_commits: gitCommitsStep },
      outputs,
      notices,
      effective_settings: options.effectiveSettings,
    }, stderr);
  } else {
    providerFacets = {
      ok: true,
      skipped: true,
      reason: `provider_evidence_state=${String(provider.evidence_state ?? "")}`,
      output: "",
    };
  }
  progress.update(3, "provider facets", (line) => { stderr += line; });
  progress.finish((line) => { stderr += line; });

  const counts: Record<string, unknown> = {
    raw: { git_commits: rawSourceCounts(gitCommitsPath) },
  };
  if (providerFacets.output) {
    (counts.raw as Record<string, unknown>).provider_facets = rawSourceCounts(String(providerFacets.output));
  }
  const report = {
    ok: true,
    repo_path: repo,
    memory_path: memory,
    provider,
    notices,
    effective_settings: options.effectiveSettings,
    steps: {
      prepare: jsonStep(prepare),
      git_commits: gitCommitsStep,
      provider_facets: providerFacets,
    },
    outputs,
    counts,
    next_step: "Inspect raw evidence, then author PROFILE.md and resources/*.md.",
  };
  return { exitCode: 0, stdout: jsonText(report, options.pretty), stderr };
}

function parseCollectArgs(args: string[]): CollectOptions | "help" {
  const options: CollectOptions = {
    repoPath: ".",
    reuse: false,
    snapshotRef: "HEAD",
    skipProvider: false,
    requireProvider: false,
    pretty: false,
    progress: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--repo-path") options.repoPath = requiredValue(args, index++, value);
    else if (value === "--snapshot-ref") options.snapshotRef = requiredValue(args, index++, value);
    else if (value === "--commit-limit") options.commitLimit = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--pr-limit") options.prLimit = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--issue-limit") options.issueLimit = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--summary-chars") options.summaryChars = parseInteger(requiredValue(args, index++, value), value);
    else if (value === "--history-mode") options.historyMode = requiredValue(args, index++, value);
    else if (value === "--reuse") options.reuse = true;
    else if (value === "--skip-provider") options.skipProvider = true;
    else if (value === "--require-provider") options.requireProvider = true;
    else if (value === "--pretty") options.pretty = true;
    else if (value === "--progress") options.progress = true;
    else if (value === "--help" || value === "-h") return "help";
    else throw new RepoMemoryError(`unrecognized arguments: ${value}`, 2);
  }
  if (options.historyMode && !HISTORY_MODES.has(options.historyMode)) {
    throw new RepoMemoryError(`--history-mode must be one of ${[...HISTORY_MODES].sort().join(", ")}`, 2);
  }
  if (options.skipProvider && options.requireProvider) {
    throw new RepoMemoryError("--skip-provider and --require-provider cannot be used together", 2);
  }
  if (options.historyMode && options.skipProvider && options.historyMode !== "local-only") {
    throw new RepoMemoryError(`--skip-provider cannot be combined with --history-mode ${options.historyMode}`, 2);
  }
  if (options.historyMode && options.requireProvider && options.historyMode !== "provider-required") {
    throw new RepoMemoryError("--require-provider cannot be combined with a non-required history mode", 2);
  }
  return options;
}

function applyEffectiveSettings(options: CollectOptions, skillDir: string): EffectiveCollectOptions {
  const defaultsPath = join(skillDir, "defaults.json");
  const { settings, source } = loadDefaultSettings(defaultsPath);
  const defaultMode = defaultHistoryMode(settings, defaultsPath);
  let historyMode = options.historyMode ?? defaultMode;
  if (options.skipProvider) historyMode = "local-only";
  if (options.requireProvider) historyMode = "provider-required";
  const historyCollect = { commits: historyMode !== "none", provider: historyMode === "provider" || historyMode === "provider-required" };
  const commitLimit = options.commitLimit ?? defaultLimit(settings, "commits", defaultsPath);
  const prLimit = options.prLimit ?? defaultLimit(settings, "prs", defaultsPath);
  const issueLimit = options.issueLimit ?? defaultLimit(settings, "issues", defaultsPath);
  const summaryChars = options.summaryChars ?? defaultInteger(settings, ["summaryChars"], FALLBACK_DEFAULTS.summaryChars, defaultsPath);
  assertRange("--commit-limit", commitLimit, 1, 500);
  assertRange("--pr-limit", prLimit, 1, 100);
  assertRange("--issue-limit", issueLimit, 1, 100);
  if (summaryChars < 100) throw new RepoMemoryError("--summary-chars must be at least 100", 2);
  const overrides: Record<string, unknown> = {};
  if (options.historyMode !== undefined) overrides.history_mode = options.historyMode;
  if (options.skipProvider) overrides.skip_provider = true;
  if (options.requireProvider) overrides.require_provider = true;
  if (options.commitLimit !== undefined) overrides.commit_limit = options.commitLimit;
  if (options.prLimit !== undefined) overrides.pr_limit = options.prLimit;
  if (options.issueLimit !== undefined) overrides.issue_limit = options.issueLimit;
  if (options.summaryChars !== undefined) overrides.summary_chars = options.summaryChars;
  return {
    ...options,
    historyMode,
    historyCollect,
    commitLimit,
    prLimit,
    issueLimit,
    summaryChars,
    effectiveSettings: {
      history: { mode: historyMode, collect: historyCollect },
      limits: { commits: commitLimit, prs: prLimit, issues: issueLimit },
      summary_chars: summaryChars,
      source,
      overrides,
    },
  };
}

function loadDefaultSettings(path: string): { settings: Record<string, unknown>; source: string } {
  if (!existsSync(path)) return { settings: FALLBACK_DEFAULTS, source: "hardcoded_fallback" };
  const text = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RepoMemoryError(`${path}: invalid JSON at ${readJsonError(error, text)}`, 2);
  }
  if (!isRecord(value)) throw new RepoMemoryError(`${path}: expected a JSON object`, 2);
  return { settings: value, source: path };
}

function defaultHistoryMode(settings: Record<string, unknown>, path: string): string {
  const history = isRecord(settings.repoHistory) ? settings.repoHistory : undefined;
  if (!history) return "provider";
  const mode = history.mode ?? "provider";
  if (typeof mode !== "string" || !HISTORY_MODES.has(mode)) {
    throw new RepoMemoryError(`${path}: repoHistory.mode must be one of ${[...HISTORY_MODES].sort().join(", ")}`, 2);
  }
  return mode;
}

function defaultLimit(settings: Record<string, unknown>, key: "commits" | "prs" | "issues", path: string): number {
  const history = isRecord(settings.repoHistory) ? settings.repoHistory : undefined;
  const limits = history && isRecord(history.limits) ? history.limits : undefined;
  if (limits?.[key] !== undefined) return defaultInteger(settings, ["repoHistory", "limits", key], FALLBACK_DEFAULTS.repoHistory.limits[key], path);
  return defaultInteger(settings, ["limits", key], FALLBACK_DEFAULTS.limits[key], path);
}

function defaultInteger(settings: Record<string, unknown>, keys: string[], fallback: number, path: string): number {
  let value: unknown = settings;
  for (const key of keys) value = isRecord(value) ? value[key] : undefined;
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw new RepoMemoryError(`${path}: ${keys.join(".")} must be an integer`, 2);
  return value as number;
}

function providerReport(prepare: Record<string, unknown>): Record<string, unknown> {
  return {
    name: prepare.git_provider ?? "",
    repo: prepare.git_remote_repo ?? "",
    host: prepare.git_remote_host ?? "",
    remote_name: prepare.git_remote_name ?? "",
    selection_reason: prepare.git_remote_selection_reason ?? "",
    cli: prepare.provider_cli ?? "",
    cli_available: Boolean(prepare.provider_cli_available),
    authenticated: Boolean(prepare.provider_authenticated),
    auth_status: prepare.provider_auth_status ?? "",
    evidence_state: prepare.provider_evidence_state ?? "",
    login_hint: prepare.provider_login_hint ?? "",
    notice_level: prepare.provider_notice_level ?? "",
    user_notice: prepare.provider_user_notice ?? "",
    notice_markdown: prepare.provider_notice_markdown ?? "",
    next_steps: prepare.provider_next_steps ?? [],
  };
}

function providerNotices(prepare: Record<string, unknown>): Record<string, unknown>[] {
  if (prepare.provider_notice_level !== "warning") return [];
  return [{
    level: "warning",
    title: "Provider Evidence Unavailable",
    message: String(prepare.provider_user_notice ?? "").replaceAll("`", ""),
    command: prepare.provider_login_hint ?? "",
    next_steps: prepare.provider_next_steps ?? [],
    render_as: "assistant_message",
  }];
}

function providerFailureNotice(provider: Record<string, unknown>, result: CommandOutput, continuing: boolean): Record<string, unknown> {
  let detail = (result.stderr.trim() || result.stdout.trim() || "provider facet collection failed").replaceAll("`", "");
  if (detail.length > 800) detail = `${detail.slice(0, 800)}...`;
  const name = String(provider.name || "provider");
  const evidence = name === "github" ? "GitHub PR/issue" : name === "gitlab" ? "GitLab MR/issue" : "provider";
  const continuation = continuing
    ? "Continuing with local-only repo memory now."
    : "Provider evidence was required, so the run stopped before authoring provider resources.";
  return {
    level: "warning",
    title: "Provider Evidence Unavailable",
    message: `${evidence} evidence could not be collected even though the provider CLI appeared ready. ${continuation} Provider error: ${detail}`,
    command: "",
    next_steps: [
      "Fix provider repository access or remote URL.",
      `Rerun $memorax-code repo-build to collect ${evidence} evidence.`,
    ],
    render_as: "assistant_message",
  };
}

function providerRawName(provider: string): string {
  return provider === "github" ? "github-facets.json" : provider === "gitlab" ? "gitlab-facets.json" : "provider-facets.json";
}

function jsonStep(output: CommandOutput): Record<string, unknown> {
  return { ok: output.exitCode === 0, exit_code: output.exitCode, stdout: output.stdout.trim(), stderr: output.stderr.trim() };
}

function writeFailure(
  failedStep: string,
  result: CommandOutput,
  pretty: boolean,
  details: {
    repo?: string;
    memory?: string;
    provider?: Record<string, unknown>;
    steps?: Record<string, unknown>;
    outputs?: Record<string, string>;
    notices?: Record<string, unknown>[];
    effective_settings?: Record<string, unknown>;
  },
  priorStderr: string,
): CommandOutput {
  const steps = { ...(details.steps ?? {}), [failedStep]: jsonStep(result) };
  const report: Record<string, unknown> = { ok: false, failed_step: failedStep, steps };
  if (details.repo) report.repo_path = details.repo;
  if (details.memory) report.memory_path = details.memory;
  if (details.provider) report.provider = details.provider;
  if (details.outputs && Object.keys(details.outputs).length) report.outputs = details.outputs;
  if (details.notices?.length) report.notices = details.notices;
  if (details.effective_settings) report.effective_settings = details.effective_settings;
  const emitted = [result.stderr, result.stdout].filter(Boolean).map(ensureNewline).join("");
  return { exitCode: result.exitCode || 1, stdout: jsonText(report, pretty), stderr: `${priorStderr}${emitted}` };
}

function rawSourceCounts(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value)) return {};
  const counts: Record<string, number> = {};
  for (const item of value) {
    const sourceType = isRecord(item) ? String(item.sourceType || "unknown") : "unknown";
    counts[sourceType] = (counts[sourceType] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function loadJsonObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value)) throw new RepoMemoryError(`${path}: expected a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

class ProgressBar {
  private readonly enabled: boolean;
  private readonly total: number;
  private readonly width = 20;
  private lastLineLength = 0;
  private readonly tty = Boolean(process.stderr.isTTY);

  constructor(enabled: boolean, total: number) {
    this.enabled = enabled;
    this.total = total;
  }

  update(completedValue: number, label: string, write: (message: string) => void): void {
    if (!this.enabled) return;
    const completed = Math.max(0, Math.min(completedValue, this.total));
    const filled = this.total ? Math.round((completed / this.total) * this.width) : this.width;
    const bar = "#".repeat(filled) + "-".repeat(this.width - filled);
    const line = `memorax-code repo-build [${bar}] ${completed}/${this.total} ${label}`;
    if (this.tty) {
      const padding = " ".repeat(Math.max(0, this.lastLineLength - line.length));
      write(`\r${line}${padding}`);
      this.lastLineLength = line.length;
    } else {
      write(`${line}\n`);
    }
  }

  fail(completed: number, label: string, write: (message: string) => void): void {
    this.update(completed, label, write);
    this.finish(write);
  }

  finish(write: (message: string) => void): void {
    if (this.enabled && this.tty) write("\n");
  }
}

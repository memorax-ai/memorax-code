import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  canonicalPath,
  commandAvailable,
  commandOutput,
  failedOutput,
  RepoMemoryError,
  runCommand,
  type CommandOutput,
} from "./shared.js";

const REPO_MEMORY_GITIGNORE_RULE = ".repo_memory/";
const PREFERRED_REMOTE_NAMES = ["upstream", "origin"];

interface RemoteReport {
  provider: string;
  repo: string;
  host: string;
  url: string;
  remote_name: string;
  selection_reason: string;
}

interface AuthState {
  available: boolean;
  authenticated: boolean;
  auth_status: string;
  auth_error: string;
  login_hint: string;
}

export function prepareRepoMemory(repoValue: string, reuse: boolean): Record<string, unknown> {
  const repo = canonicalPath(repoValue);
  if (!existsSync(repo)) throw new RepoMemoryError(`Repository path does not exist: ${repo}`);
  if (!commandAvailable("git")) throw new RepoMemoryError("git is required but was not found on PATH");
  if (!isGitRepo(repo)) throw new RepoMemoryError(nonGitRepoNotice(repo));

  const memory = join(repo, ".repo_memory");
  if (existsSync(memory) && !reuse && !isSidecarOnlyMemory(memory)) {
    throw new RepoMemoryError(`${memory} already exists. Stop by default; rerun with --reuse to update it.`);
  }
  for (const directory of [memory, join(memory, "raw"), join(memory, "resources")]) {
    mkdirSync(directory, { recursive: true });
  }

  const remotes = gitValue(repo, ["remote", "-v"]);
  const remote = parseCodeHostRepo(remotes);
  const gitignoreUpdated = ensureRepoMemoryGitignore(repo);
  const ghHost = remote.provider === "github" ? remote.host : "";
  const glabHost = remote.provider === "gitlab" ? remote.host : "";
  const ghState = cliAuthState("gh", authArgs("gh", ghHost), loginHint("gh", ghHost));
  const glabState = cliAuthState("glab", authArgs("glab", glabHost), loginHint("glab", glabHost));
  const providerReport = providerCliReport(remote.provider, ghState, glabState);
  const report: Record<string, unknown> = {
    prepared_at: new Date().toISOString(),
    repo_path: repo,
    memory_path: memory,
    is_git_repo: true,
    local_head: gitValue(repo, ["rev-parse", "HEAD"]),
    local_branch: gitValue(repo, ["branch", "--show-current"]) || "(detached HEAD)",
    working_tree_state: gitValue(repo, ["status", "--short"]) ? "dirty" : "clean",
    git_remotes: remotes.split(/\r?\n/).filter(Boolean),
    git_provider: remote.provider,
    git_remote_repo: remote.repo,
    git_remote_host: remote.host,
    git_remote_url: remote.url,
    git_remote_name: remote.remote_name,
    git_remote_selection_reason: remote.selection_reason,
    github_repo: remote.provider === "github" ? remote.repo : "",
    gitlab_repo: remote.provider === "gitlab" ? remote.repo : "",
    gh_available: ghState.available,
    gh_authenticated: ghState.authenticated,
    gh_auth_status: ghState.auth_status,
    gh_auth_error: ghState.auth_error,
    gh_login_hint: ghState.login_hint,
    glab_available: glabState.available,
    glab_authenticated: glabState.authenticated,
    glab_auth_status: glabState.auth_status,
    glab_auth_error: glabState.auth_error,
    glab_login_hint: glabState.login_hint,
    ...providerReport,
    gitignore_path: join(repo, ".gitignore"),
    gitignore_rule: REPO_MEMORY_GITIGNORE_RULE,
    gitignore_updated: gitignoreUpdated,
    created_directories: [".repo_memory", ".repo_memory/raw", ".repo_memory/resources"],
    next_step: "Agent must inspect local code/docs and author PROFILE.md and resources. This script intentionally does not generate memory content.",
  };
  writeFileSync(join(memory, "raw", "prepare-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function executePrepare(args: string[]): CommandOutput {
  try {
    let repo = ".";
    let repoSeen = false;
    let reuse = false;
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (value === "--reuse") reuse = true;
      else if (value === "--pretty") continue;
      else if (value === "--help" || value === "-h") {
        return { exitCode: 0, stdout: `${prepareUsage()}\n`, stderr: "" };
      } else if (value.startsWith("-")) {
        throw new RepoMemoryError(`unrecognized arguments: ${value}`, 2);
      } else if (repoSeen) {
        throw new RepoMemoryError(`unrecognized arguments: ${value}`, 2);
      } else {
        repo = value;
        repoSeen = true;
      }
    }
    return commandOutput(prepareRepoMemory(repo, reuse), true);
  } catch (error) {
    return failedOutput(error);
  }
}

export function prepareUsage(): string {
  return "Usage: memorax-code repo-memory prepare [REPO] [--reuse]";
}

function isGitRepo(repo: string): boolean {
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo });
  return result.status === 0 && result.stdout.trim() === "true";
}

function gitValue(repo: string, args: string[]): string {
  const result = runCommand("git", args, { cwd: repo });
  return result.status === 0 ? result.stdout.trim() : "";
}

function normalizeRemotePath(path: string): string {
  let repoPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (repoPath.endsWith(".git")) repoPath = repoPath.slice(0, -4);
  return repoPath;
}

function providerFromHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower.includes("github")) return "github";
  if (lower === "gitlab.com" || lower.includes("gitlab")) return "gitlab";
  return "";
}

export function parseRemoteUrl(value: string): Omit<RemoteReport, "remote_name" | "selection_reason"> {
  if (!value) return { provider: "", repo: "", host: "", url: "" };
  if (!value.includes("://")) {
    const match = /^(?:[^@/\s]+@)?(?<host>[^:/\s]+):(?<path>.+)$/.exec(value);
    if (match?.groups) {
      const host = match.groups.host;
      return {
        provider: providerFromHost(host),
        repo: normalizeRemotePath(match.groups.path),
        host,
        url: value,
      };
    }
  }
  try {
    const parsed = new URL(value);
    return {
      provider: providerFromHost(parsed.hostname),
      repo: normalizeRemotePath(parsed.pathname),
      host: parsed.hostname,
      url: value,
    };
  } catch {
    return { provider: "", repo: "", host: "", url: value };
  }
}

export function parseCodeHostRepo(remotes: string): RemoteReport {
  const candidates: RemoteReport[] = [];
  for (const line of remotes.split(/\r?\n/)) {
    if (line.includes("(push)")) continue;
    const parts = line.trim().split(/\s+/);
    const parsed = parseRemoteUrl(parts[1] ?? "");
    if (parsed.provider && parsed.repo) {
      candidates.push({ ...parsed, remote_name: parts[0] ?? "", selection_reason: "" });
    }
  }
  for (const preferred of PREFERRED_REMOTE_NAMES) {
    const candidate = candidates.find((item) => item.remote_name === preferred);
    if (candidate) return { ...candidate, selection_reason: `preferred_${preferred}_fetch_remote` };
  }
  if (candidates[0]) return { ...candidates[0], selection_reason: "first_supported_fetch_remote" };
  return { provider: "", repo: "", host: "", url: "", remote_name: "", selection_reason: "none" };
}

function authArgs(command: string, host: string): string[] {
  const args = ["auth", "status"];
  if (host && (command === "gh" || command === "glab")) args.push("--hostname", host);
  return args;
}

function loginHint(command: string, host: string): string {
  const defaultHost = command === "gh" ? "github.com" : command === "glab" ? "gitlab.com" : "";
  return host && host !== defaultHost
    ? `${command} auth login --hostname ${host}`
    : `${command} auth login`;
}

function cliAuthState(command: string, args: string[], hint: string): AuthState {
  if (!commandAvailable(command)) {
    return { available: false, authenticated: false, auth_status: "cli_missing", auth_error: "", login_hint: hint };
  }
  const result = runCommand(command, args, { cwd: process.cwd(), timeoutMs: 8000 });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    return {
      available: true,
      authenticated: false,
      auth_status: "auth_check_timeout",
      auth_error: `${command} auth check timed out`,
      login_hint: hint,
    };
  }
  if (result.status === 0) {
    return { available: true, authenticated: true, auth_status: "authenticated", auth_error: "", login_hint: hint };
  }
  const lines = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/);
  return {
    available: true,
    authenticated: false,
    auth_status: "auth_required",
    auth_error: lines[0]?.slice(0, 500) ?? "",
    login_hint: hint,
  };
}

function providerLabel(provider: string): string {
  return provider === "github" ? "GitHub" : provider === "gitlab" ? "GitLab" : "Git provider";
}

function providerEvidenceLabel(provider: string): string {
  return provider === "github" ? "GitHub PR/issue" : provider === "gitlab" ? "GitLab MR/issue" : "provider";
}

function noticeMarkdown(body: string, command: string, rerunLine: string): string {
  const lines = [
    "**Provider Evidence Unavailable**",
    "",
    `> ${body}`,
    "> Continuing with local-only repo memory now.",
    "",
    "**Next steps for provider evidence**",
  ];
  if (command) lines.push("", "```bash", command, "```");
  lines.push(rerunLine);
  return lines.join("\n").trim();
}

function providerNotice(provider: string, cli: string, evidenceState: string, hint: string): Record<string, unknown> {
  const label = providerLabel(provider);
  const evidenceLabel = providerEvidenceLabel(provider);
  if (evidenceState === "ready") {
    return {
      provider_notice_level: "info",
      provider_user_notice: `${label} provider evidence is ready; ${evidenceLabel} evidence can be collected.`,
      provider_notice_markdown: `**Provider Evidence Ready**\n\n> ${label} provider evidence is ready.\n\n\`${evidenceLabel}\` evidence can be collected.`,
      provider_next_steps: [],
    };
  }
  if (evidenceState === "auth_required") {
    const body = `${label} provider evidence is unavailable because \`${cli}\` is not logged in.`;
    const rerunLine = `Rerun $memorax-code repo-build to collect ${evidenceLabel} evidence.`;
    return {
      provider_notice_level: "warning",
      provider_user_notice: `${body} I am continuing with local-only repo memory now. To include ${evidenceLabel} evidence, run \`${hint}\`, then rerun $memorax-code repo-build.`,
      provider_notice_markdown: noticeMarkdown(body, hint, rerunLine),
      provider_next_steps: [`Run: ${hint}`, rerunLine],
    };
  }
  if (evidenceState === "cli_missing") {
    const body = `${label} provider evidence is unavailable because \`${cli}\` is not installed.`;
    const rerunLine = `Rerun $memorax-code repo-build to collect ${evidenceLabel} evidence.`;
    return {
      provider_notice_level: "warning",
      provider_user_notice: `${body} I am continuing with local-only repo memory now. To include ${evidenceLabel} evidence, install \`${cli}\`, run \`${hint}\`, then rerun $memorax-code repo-build.`,
      provider_notice_markdown: noticeMarkdown(body, hint, rerunLine),
      provider_next_steps: [`Install: ${cli}`, `Run: ${hint}`, rerunLine],
    };
  }
  return {
    provider_notice_level: "info",
    provider_user_notice: "No supported GitHub/GitLab remote was detected; continuing with local-only repo memory.",
    provider_notice_markdown: "**Provider Evidence Unavailable**\n\n> No supported GitHub/GitLab remote was detected.\n> Continuing with local-only repo memory.",
    provider_next_steps: [],
  };
}

function providerCliReport(provider: string, gh: AuthState, glab: AuthState): Record<string, unknown> {
  let state: AuthState;
  let cli: string;
  if (provider === "github") {
    state = gh;
    cli = "gh";
  } else if (provider === "gitlab") {
    state = glab;
    cli = "glab";
  } else {
    return {
      provider_cli: "",
      provider_cli_available: false,
      provider_authenticated: false,
      provider_auth_status: "no_supported_remote",
      provider_evidence_state: "unavailable",
      provider_login_hint: "",
      provider_fallback: "No supported GitHub/GitLab remote was detected; build local-only repo memory.",
      ...providerNotice(provider, "", "unavailable", ""),
    };
  }
  const evidenceState = !state.available ? "cli_missing" : !state.authenticated ? "auth_required" : "ready";
  const fallback = !state.available
    ? `${cli} is not installed; build local-only repo memory unless the user installs the provider CLI.`
    : !state.authenticated
      ? `${cli} is not authenticated; build local-only repo memory unless the user logs in and reruns provider collection.`
      : "Provider evidence can be collected.";
  return {
    provider_cli: cli,
    provider_cli_available: state.available,
    provider_authenticated: state.authenticated,
    provider_auth_status: state.auth_status,
    provider_evidence_state: evidenceState,
    provider_login_hint: state.login_hint,
    provider_fallback: fallback,
    ...providerNotice(provider, cli, evidenceState, state.login_hint),
  };
}

function gitignoreHasRepoMemoryRule(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || stripped.startsWith("!")) return false;
    const rule = stripped.split("#", 1)[0].trim().replace(/^\/+/, "");
    return rule === ".repo_memory" || rule === ".repo_memory/";
  });
}

function ensureRepoMemoryGitignore(repo: string): boolean {
  const path = join(repo, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (gitignoreHasRepoMemoryRule(existing)) return false;
  const separator = !existing || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${separator}${REPO_MEMORY_GITIGNORE_RULE}\n`, "utf8");
  return true;
}

function isSidecarOnlyMemory(memory: string): boolean {
  try {
    const metadata = lstatSync(memory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const children = readdirSync(memory, { withFileTypes: true });
    return children.length > 0 && children.every((child) => (
      (child.name === "user-profile" || child.name === "procedure-memory")
      && child.isDirectory()
      && !child.isSymbolicLink()
    ));
  } catch {
    return false;
  }
}

function nonGitRepoNotice(repo: string): string {
  return [
    "**Repo Memory Cannot Be Built Yet**",
    "",
    `> This folder is not a git repository: ${repo}`,
    "> The $memorax-code repo-build operation cannot collect local commit history or provider-linked PR/MR/issue evidence.",
    "",
    "**Next steps**",
    "- If this is an existing project, open the real cloned repo directory.",
    "- If this is a new project, run `git init` first, make at least one commit, then rerun $memorax-code repo-build.",
    "- If you only want file inspection, continue by inspecting files without repo memory.",
  ].join("\n");
}

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJsonFile, stringOption } from "../config-utils.mjs";

const MAX_CONTEXT_CHARS = 4000;
const MAX_PREFERENCES_BYTES = 64 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 2000;
const PREFERENCES_GIT_PATH = ".repo_memory/user-profile/preferences.md";
const PREFERENCES_RELATIVE_PATH = join(".repo_memory", "user-profile", "preferences.md");
const PREFERENCES_SCHEMA = "repo_user_profile_memory.v0.1";
const PREFERENCES_OWNER = "repo-user-profile-memory";
const ALLOWED_TYPES = new Set(["communication", "workflow", "environment", "profile"]);
const ALLOWED_STATUSES = new Set(["active", "superseded", "deleted"]);

export function buildRepoUserProfilePreferencesContext(input, options) {
  const cwd = resolveCwd(input, options);
  if (!cwd) return undefined;
  const repoRoot = gitRepoRoot(cwd);
  if (!repoRoot) return undefined;
  const preferences = readTrustedPreferences(repoRoot, options);
  if (!preferences || preferences.length === 0) return undefined;
  return renderContext(preferences);
}

function readTrustedPreferences(repoRoot, options) {
  const path = join(repoRoot, PREFERENCES_RELATIVE_PATH);
  if (!existsSync(path)) return undefined;
  try {
    for (const directory of [dirname(path), dirname(dirname(path))]) {
      const directoryStat = lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        debug(options, `Skipping untrusted repo user preferences directory: ${PREFERENCES_GIT_PATH}`);
        return undefined;
      }
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_PREFERENCES_BYTES) {
      debug(options, `Skipping untrusted repo user preferences: ${PREFERENCES_GIT_PATH}`);
      return undefined;
    }
    const trackedStatus = gitExitCode(repoRoot, ["ls-files", "--error-unmatch", "--", PREFERENCES_GIT_PATH]);
    if (trackedStatus === 0) {
      debug(options, `Skipping tracked repo user preferences: ${PREFERENCES_GIT_PATH}`);
      return undefined;
    }
    if (trackedStatus !== 1 || gitExitCode(repoRoot, ["check-ignore", "-q", "--", PREFERENCES_GIT_PATH]) !== 0) {
      debug(options, `Skipping unignored repo user preferences: ${PREFERENCES_GIT_PATH}`);
      return undefined;
    }
    return parseActivePreferences(readFileSync(path, "utf8"));
  } catch (error) {
    debug(options, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function parseActivePreferences(text) {
  if (text.includes("\0")) return undefined;
  const metadata = parseFrontmatter(text);
  if (
    !metadata
    || metadata.schema !== PREFERENCES_SCHEMA
    || metadata.scope !== "repo"
    || metadata.owner !== PREFERENCES_OWNER
    || metadata.trust_state !== "user_stated"
  ) {
    return undefined;
  }
  const declaredActive = nonNegativeInteger(metadata.active_count);
  const declaredTotal = nonNegativeInteger(metadata.total_count);
  if (declaredActive === undefined || declaredTotal === undefined) return undefined;

  const matches = [...text.matchAll(/^## Preference (?<id>pref_[^\s]+)\s*$/gm)];
  if (matches.length !== declaredTotal) return undefined;
  const preferences = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    const status = stripTicks(field(block, "Status")).toLowerCase();
    const type = stripTicks(field(block, "Type"));
    if (!ALLOWED_STATUSES.has(status) || !ALLOWED_TYPES.has(type)) return undefined;
    if (
      !stripTicks(field(block, "Confidence"))
      || !stripTicks(field(block, "Created"))
      || !stripTicks(field(block, "Updated"))
    ) {
      return undefined;
    }
    if (status !== "active") continue;
    const description = normalizeField(field(block, "Description"));
    if (!description) return undefined;
    preferences.push({
      description,
      appliesWhen: normalizeField(field(block, "Applies when")),
      doNotApplyWhen: normalizeField(field(block, "Do not apply when")),
    });
  }
  return preferences.length === declaredActive ? preferences : undefined;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const metadata = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) return undefined;
    metadata[fieldMatch[1]] = stripYamlScalar(fieldMatch[2]);
  }
  return metadata;
}

function stripYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && ["\"", "'"].includes(trimmed[0])) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function nonNegativeInteger(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("_", "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function field(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^- ${escaped}:\\s*(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

function stripTicks(value) {
  return String(value ?? "").trim().replace(/^`|`$/g, "").trim();
}

function normalizeField(value) {
  const normalized = stripTicks(value).replace(/\s+/g, " ").trim();
  return normalized === "-" ? "" : normalized;
}

function renderContext(preferences) {
  let context = [
    "Active repo-scoped user preferences explicitly saved by the user:",
    "Stored preferences are fallback guidance, not facts about current code behavior.",
    "Instruction priority: system/developer/AGENTS.md > current user > stored preference.",
    "Apply each preference only when relevant and not overridden by higher-priority instructions.",
  ].join("\n");
  let omitted = false;
  for (const preference of preferences) {
    const entry = [
      `- Description: ${preference.description}`,
      `  Applies when: ${preference.appliesWhen || "-"}`,
      `  Do not apply when: ${preference.doNotApplyWhen || "-"}`,
    ].join("\n");
    if (`${context}\n\n${entry}`.length > MAX_CONTEXT_CHARS) {
      omitted = true;
      break;
    }
    context += `\n\n${entry}`;
  }
  if (omitted) {
    const notice = "\n\n[Additional user preferences were omitted.]";
    context = `${context.slice(0, MAX_CONTEXT_CHARS - notice.length).trimEnd()}${notice}`;
  }
  return context;
}

function resolveCwd(input, options) {
  const resolvedWorktree = stringOption(options?.resolvedWorktree);
  if (resolvedWorktree) return resolvedWorktree;
  if (options?.requireResolvedWorktree === true) return undefined;
  const cwd = stringOption(input.cwd);
  if (cwd) return cwd;
  const sessionId = stringOption(input.session_id) ?? stringOption(input.sessionId);
  const transcriptPath = stringOption(input.transcript_path) ?? stringOption(input.transcriptPath);
  const pluginWorkspace = process.env.PLUGIN_DATA
    ? workspaceCwdFromState(join(process.env.PLUGIN_DATA, "workspaces.json"), options.sessionKeyPrefix, sessionId, transcriptPath)
    : undefined;
  if (pluginWorkspace) return pluginWorkspace;
  const memoraxCodeHome = process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
  return workspaceCwdFromState(
    join(memoraxCodeHome, "adapters", options.adapterDir, "workspaces.json"),
    options.sessionKeyPrefix,
    sessionId,
    transcriptPath,
  );
}

function workspaceCwdFromState(path, sessionKeyPrefix, sessionId, transcriptPath) {
  const state = readJsonFile(path);
  if (state?.unreadable) return undefined;
  const sessions = state?.value?.sessions && typeof state.value.sessions === "object" && !Array.isArray(state.value.sessions)
    ? state.value.sessions
    : {};
  for (const key of registryKeys(sessionKeyPrefix, sessionId, transcriptPath)) {
    const record = sessions[key];
    const cwd = stringOption(record?.cwd) ?? stringOption(record?.workspace);
    if (cwd) return cwd;
  }
  return undefined;
}

function registryKeys(sessionKeyPrefix, ...values) {
  const keys = new Set();
  for (const value of values) {
    const string = stringOption(value);
    if (!string) continue;
    keys.add(string);
    const base = string.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? string;
    keys.add(base);
    if (string.startsWith(`${sessionKeyPrefix}_`)) keys.add(string.slice(sessionKeyPrefix.length + 1));
    else keys.add(`${sessionKeyPrefix}_${string}`);
    if (base.startsWith(`${sessionKeyPrefix}_`)) keys.add(base.slice(sessionKeyPrefix.length + 1));
    else keys.add(`${sessionKeyPrefix}_${base}`);
  }
  return keys;
}

function gitRepoRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitExitCode(repoRoot, args) {
  try {
    execFileSync("git", ["-C", repoRoot, ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    return 0;
  } catch (error) {
    return Number.isInteger(error?.status) ? error.status : undefined;
  }
}

function debug(options, message) {
  if (process.env[options.debugEnv] === "1") console.error(message);
}

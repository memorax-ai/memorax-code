import { spawn } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readJsonFile, stringOption } from "../config-utils.mjs";
import { readActiveRepoMemoryJobMarker } from "./repo-memory-job-marker.mjs";

const MAX_GIT_POINTER_BYTES = 64 * 1024;

export function scheduleMissingRepoMemoryBuild(input, options = {}) {
  try {
    if (hookEvent(input) !== "UserPromptSubmit") return skipped("inapplicable_event");
    if (workspaceKind(input) === "projectless") return skipped("projectless_workspace");

    const cwd = resolveHookCwd(input, options);
    if (!cwd) return skipped("workspace_unavailable");
    const repo = resolveGitWorktreeRoot(cwd);
    if (!repo) return skipped("git_worktree_unavailable");
    if (repoMemoryProfileExists(repo)) return skipped("profile_present", { repo });

    const jobHookPath = resolveJobHookPath(options.pluginRoot);
    if (!jobHookPath) return skipped("job_hook_unavailable", { repo });

    const memoraxCodeHome = process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
    const active = readActiveRepoMemoryJobMarker({
      memoraxCodeHome,
      repoRealpath: repo,
    });
    if (active.active) return skipped("active_job", { repo });

    const child = spawn(process.execPath, [jobHookPath, "maintain", "--repo", repo], {
      cwd: repo,
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => debug(options, error));
    child.unref();
    return {
      ok: true,
      scheduled: true,
      reason: "profile_missing",
      repo,
    };
  } catch (error) {
    debug(options, error);
    return skipped("check_failed");
  }
}

export function resolveGitWorktreeRoot(cwd) {
  let current = canonicalDirectory(cwd);
  if (!current) return undefined;

  while (true) {
    const marker = join(current, ".git");
    const state = gitMarkerState(marker);
    if (state === "valid") return current;
    if (state === "invalid") return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function gitMarkerState(marker) {
  let metadata;
  try {
    metadata = lstatSync(marker);
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : "invalid";
  }
  if (metadata.isSymbolicLink()) return "invalid";
  try {
    const gitDir = metadata.isDirectory()
      ? canonicalDirectory(marker)
      : metadata.isFile()
        ? resolveGitPointer(marker)
        : undefined;
    if (!gitDir) return "invalid";
    validateGitDirectory(gitDir);
    return "valid";
  } catch {
    return "invalid";
  }
}

function resolveGitPointer(marker) {
  const line = readSingleLine(marker, MAX_GIT_POINTER_BYTES);
  const match = /^gitdir:[ \t]*(.+)$/i.exec(line);
  const value = match?.[1]?.trim();
  if (!value || value.includes("\0")) return undefined;
  return canonicalDirectory(isAbsolute(value) ? value : resolve(dirname(marker), value));
}

function validateGitDirectory(gitDir) {
  const head = readSingleLine(join(gitDir, "HEAD"), MAX_GIT_POINTER_BYTES).trim();
  if (!/^ref: refs\/[^\0\r\n]+$/.test(head) && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(head)) {
    throw new Error("invalid Git HEAD");
  }

  const commonDirPath = join(gitDir, "commondir");
  let commonDir = gitDir;
  try {
    const metadata = lstatSync(commonDirPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("invalid Git common directory pointer");
    const value = readSingleLine(commonDirPath, MAX_GIT_POINTER_BYTES).trim();
    if (!value || value.includes("\0")) throw new Error("invalid Git common directory pointer");
    commonDir = canonicalDirectory(isAbsolute(value) ? value : resolve(gitDir, value));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!commonDir || !statSync(join(commonDir, "objects")).isDirectory()) {
    throw new Error("invalid Git objects directory");
  }
  const hasRefs = directoryExists(join(commonDir, "refs"));
  const hasReftable = directoryExists(join(commonDir, "reftable"));
  if (!hasRefs && !hasReftable) throw new Error("invalid Git refs directory");
}

function repoMemoryProfileExists(repo) {
  try {
    lstatSync(join(repo, ".repo_memory", "PROFILE.md"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveJobHookPath(pluginRoot) {
  const rootValue = stringOption(pluginRoot);
  if (!rootValue) return undefined;
  const root = canonicalDirectory(rootValue);
  if (!root) return undefined;
  const target = join(root, "hooks", "repo-memory-job.mjs");
  return isContainedRegularFile(root, target) ? target : undefined;
}

function resolveHookCwd(input, options) {
  const direct = safeRealpath(stringOption(input?.cwd));
  if (direct) return direct;
  const sessionId = stringOption(input?.session_id) ?? stringOption(input?.sessionId);
  const transcriptPath = stringOption(input?.transcript_path) ?? stringOption(input?.transcriptPath);
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
    const cwd = safeRealpath(stringOption(record?.cwd) ?? stringOption(record?.workspace));
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

function hookEvent(input) {
  return stringOption(input?.hook_event_name)
    ?? stringOption(input?.hookEventName)
    ?? stringOption(input?.event)
    ?? stringOption(input?.type);
}

function workspaceKind(input) {
  return (stringOption(input?.workspace_kind) ?? stringOption(input?.workspaceKind))?.toLowerCase();
}

function canonicalDirectory(path) {
  const value = stringOption(path);
  if (!value) return undefined;
  try {
    const canonical = realpathSync(resolve(value));
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function safeRealpath(path) {
  const value = stringOption(path);
  if (!value) return undefined;
  try {
    return realpathSync(resolve(value));
  } catch {
    return undefined;
  }
}

function readSingleLine(path, maxBytes) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
    throw new Error("invalid Git metadata file");
  }
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes || text.includes("\0")) {
    throw new Error("invalid Git metadata file");
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > 2 || (lines.length === 2 && lines[1] !== "")) {
    throw new Error("invalid Git metadata line");
  }
  return lines[0];
}

function directoryExists(path) {
  try {
    const metadata = lstatSync(path);
    return !metadata.isSymbolicLink() && metadata.isDirectory();
  } catch {
    return false;
  }
}

function isContainedRegularFile(boundary, path) {
  try {
    const root = realpathSync(boundary);
    const target = realpathSync(path);
    const child = relative(root, target);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return false;
    const metadata = lstatSync(path);
    return !metadata.isSymbolicLink() && metadata.isFile();
  } catch {
    return false;
  }
}

function skipped(reason, details = {}) {
  return { ok: true, scheduled: false, reason, ...details };
}

function debug(options, error) {
  if (process.env[options.debugEnv] === "1") {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

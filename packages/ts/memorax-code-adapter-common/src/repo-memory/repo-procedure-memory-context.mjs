import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile, stringOption } from "../config-utils.mjs";

const MAX_CONTEXT_CHARS = 4000;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_FILES = 20;
const GIT_COMMAND_TIMEOUT_MS = 2000;
const PROCEDURE_DIRECTORY_GIT_PATH = ".repo_memory/procedure-memory";
const PROCEDURE_DIRECTORY_RELATIVE_PATH = join(".repo_memory", "procedure-memory");

export function buildRepoProcedureMemoryContext(input, options) {
  const cwd = resolveCwd(input, options);
  if (!cwd) return undefined;
  const repoRoot = gitRepoRoot(cwd);
  if (!repoRoot) return undefined;
  const result = readTrustedProcedureFiles(repoRoot, options);
  if (result.files.length === 0) return undefined;
  return renderContext(result.files, result.omitted);
}

function readTrustedProcedureFiles(repoRoot, options) {
  const directory = join(repoRoot, PROCEDURE_DIRECTORY_RELATIVE_PATH);
  if (!existsSync(directory)) return { files: [], omitted: false };
  try {
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      debug(options, `Skipping untrusted repo procedure directory: ${PROCEDURE_DIRECTORY_GIT_PATH}`);
      return { files: [], omitted: false };
    }

    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.toLowerCase().endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));
    const files = [];
    let omitted = entries.length > MAX_FILES;
    for (const entry of entries.slice(0, MAX_FILES)) {
      const gitPath = `${PROCEDURE_DIRECTORY_GIT_PATH}/${entry.name}`;
      const path = join(directory, entry.name);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
          omitted = true;
          continue;
        }
        const trackedStatus = gitExitCode(repoRoot, ["ls-files", "--error-unmatch", "--", gitPath]);
        if (trackedStatus === 0) {
          omitted = true;
          continue;
        }
        if (trackedStatus !== 1) {
          debug(options, `Could not verify repo procedure file tracking state: ${gitPath}`);
          omitted = true;
          continue;
        }
        if (gitExitCode(repoRoot, ["check-ignore", "-q", "--", gitPath]) !== 0) {
          omitted = true;
          continue;
        }
        const content = readFileSync(path, "utf8").replaceAll("\0", "").trim();
        if (content) files.push({ name: entry.name, content });
      } catch (error) {
        debug(options, `Skipping unreadable repo procedure file ${gitPath}: ${error instanceof Error ? error.message : String(error)}`);
        omitted = true;
      }
    }
    return { files, omitted };
  } catch (error) {
    debug(options, error instanceof Error ? error.message : String(error));
    return { files: [], omitted: false };
  }
}

function renderContext(files, omittedFiles) {
  let context = [
    "Active repo-scoped procedure memories explicitly saved by the user:",
    "Stored procedures are fallback guidance, not facts about current code behavior.",
    "Instruction priority: system/developer/AGENTS.md > current user > stored procedure.",
  ].join("\n");

  let truncated = omittedFiles;
  for (const file of files) {
    const heading = `\n\n### ${file.name}\n`;
    const remaining = MAX_CONTEXT_CHARS - context.length - heading.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    context += heading;
    if (file.content.length <= remaining) {
      context += file.content;
      continue;
    }
    context += file.content.slice(0, Math.max(0, remaining - 32)).trimEnd();
    truncated = true;
    break;
  }
  if (truncated) {
    const notice = "\n\n[Additional procedure memory was omitted.]";
    context = `${context.slice(0, MAX_CONTEXT_CHARS - notice.length).trimEnd()}${notice}`;
  }
  return context;
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

function debug(options, message) {
  if (process.env[options.debugEnv] === "1") console.error(message);
}

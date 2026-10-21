import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const nativePath = process.platform === "win32" ? win32 : posix;

export function resolveCodexWorkspaceKind(input, options = {}) {
  const explicitKind = stringValue(input?.workspace_kind) ?? stringValue(input?.workspaceKind);
  if (explicitKind) return explicitKind;
  return isCodexManagedTaskWorkspace(stringValue(input?.cwd), options) ? "projectless" : undefined;
}

export function isCodexManagedTaskWorkspace(value, options = {}) {
  const path = options.path ?? nativePath;
  if (!value || !path.isAbsolute(value)) return false;
  const canonicalize = options.canonicalize ?? canonicalCodexPath;
  const workspace = canonicalize(value);
  if (!workspace) return false;
  const roots = options.managedRoots ?? defaultManagedRoots(options.env);
  return roots.some((root) => managedRelativePath(canonicalize(root), workspace, path));
}

function managedRelativePath(root, workspace, pathApi) {
  if (!root || !workspace) return false;
  const path = pathApi.relative(root, workspace);
  if (!path || path.startsWith(`..${pathApi.sep}`) || path === ".." || pathApi.isAbsolute(path)) return false;
  const parts = path.split(pathApi.sep);
  return parts.length === 2 && validIsoDate(parts[0]) && Boolean(parts[1]);
}

function defaultManagedRoots(env = process.env) {
  const home = stringValue(process.platform === "win32" ? env.USERPROFILE : env.HOME)
    ?? stringValue(env.HOME)
    ?? homedir();
  const roots = [nativePath.join(home, "Documents", "Codex")];
  if (process.platform === "win32") {
    for (const key of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]) {
      const oneDrive = stringValue(env[key]);
      if (oneDrive) roots.push(nativePath.join(oneDrive, "Documents", "Codex"));
    }
  }
  return [...new Set(roots)];
}

function canonicalCodexPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function validIsoDate(value) {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}


export function resolveWorkBuddyWorkspaceKind(input, options = {}) {
  const explicit = stringValue(input?.workspace_kind) ?? stringValue(input?.workspaceKind);
  if (explicit) return explicit;
  const context = workspaceContext(options);
  const cwd = canonicalPath(stringValue(input?.cwd), context);
  if (!cwd) return undefined;
  const root = canonicalPath(workBuddyRoot(context), context);
  if (!root) return undefined;
  const relative = context.path.relative(root, cwd);
  // Only the generated task directory itself is projectless, never its children.
  return validTaskTimestamp(relative) ? "projectless" : undefined;
}

export function isQoderManagedTaskWorkspace(value, options = {}) {
  const context = workspaceContext(options);
  const workspace = canonicalPath(typeof value === "string" ? value : undefined, context);
  if (!workspace) return false;
  const root = canonicalPath(context.path.join(context.home, "Documents", "Qoder"), context);
  if (!root) return false;
  const parts = context.path.relative(root, workspace).split(context.path.sep);
  return parts.length === 2 && validIsoDate(parts[0]) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,7}$/.test(parts[1]);
}

export function isOpenCodeDefaultWorkspace(cwd, options = {}) {
  const context = workspaceContext(options);
  const workspace = canonicalPath(stringValue(cwd), context);
  if (!workspace) return false;
  const basename = context.path.basename(workspace);
  if (context.platform === "win32" ? basename.toLowerCase() !== "default project" : basename !== "Default Project") return false;
  return documentsDirectories(context).some((directory) => {
    const root = canonicalPath(directory, context);
    // Canonicalize Documents independently so its own redirection works, while
    // a Default Project symlink escaping that directory cannot claim this scope.
    const relative = root ? context.path.relative(root, workspace) : undefined;
    return context.platform === "win32" ? relative?.toLowerCase() === "default project" : relative === "Default Project";
  });
}

function workspaceContext(options) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return {
    env,
    platform,
    path: platform === "win32" ? win32 : posix,
    home: stringValue(platform === "win32" ? env.USERPROFILE : env.HOME) ?? stringValue(env.HOME) ?? homedir(),
    readFile: options.readFile ?? ((path) => readFileSync(path, "utf8")),
    realpath: options.realpath ?? realpathSync,
    execFile: options.execFile ?? execFileSync,
  };
}

function workBuddyRoot(context) {
  const { env, home, path } = context;
  const userData = stringValue(env.WORKBUDDY_USER_DATA_DIR)
    ?? path.join(stringValue(env.WORKBUDDY_CONFIG_DIR) ?? path.join(home, ".workbuddy"), "app");
  let config;
  try {
    config = JSON.parse(context.readFile(path.join(userData, "app-config.json")));
    if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  } catch (error) {
    if (error?.code !== "ENOENT") return undefined;
  }
  const configured = config?.defaultWorkspacePath;
  if (configured !== undefined && configured !== null && configured !== "") {
    const value = stringValue(configured);
    return value && path.isAbsolute(value) && path.dirname(value) !== value
      && !/[{}]|%[A-Za-z_][A-Za-z0-9_]*%|(?:^|[\\/])~(?:[\\/]|$)/.test(value)
      ? value : undefined;
  }
  const appName = stringValue(env.WORKBUDDY_APP_NAME) ?? "WorkBuddy";
  return appName !== "." && appName !== ".." && path.basename(appName) === appName ? path.join(home, appName) : undefined;
}

function documentsDirectories(context) {
  const { env, home, path, platform } = context;
  const fallback = path.join(home, "Documents");
  if (platform === "win32") {
    const systemRoot = stringValue(env.SystemRoot) ?? stringValue(env.SYSTEMROOT) ?? stringValue(env.WINDIR);
    if (!systemRoot || !path.isAbsolute(systemRoot)) return [];
    try {
      const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const output = context.execFile(executable, [
        "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('MyDocuments')",
      ], { encoding: "utf8", timeout: 1_000, maxBuffer: 16_384, windowsHide: true, env, stdio: ["ignore", "pipe", "ignore"] });
      const value = String(output).trim();
      return value && path.isAbsolute(value) ? [value] : [];
    } catch {}
    // A redirected Documents folder has one system authority. Query failures
    // must not admit an unrelated same-named folder under HOME or OneDrive.
    return [];
  }
  if (platform === "linux") {
    try {
      const configHome = stringValue(env.XDG_CONFIG_HOME) ?? path.join(home, ".config");
      const text = context.readFile(path.join(configHome, "user-dirs.dirs"));
      const line = text.split(/\r?\n/).find((value) => /^\s*XDG_DOCUMENTS_DIR\s*=/.test(value));
      if (!line) return [fallback];
      const value = /^\s*XDG_DOCUMENTS_DIR="([^"\n]*)"\s*(?:#.*)?$/.exec(line)?.[1];
      if (value === undefined) return [];
      // user-dirs.dirs is data: expand HOME only, never evaluate shell syntax.
      const expanded = value.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, home);
      return path.isAbsolute(expanded) && !/[$`\\]/.test(expanded) ? [expanded] : [];
    } catch (error) {
      return error?.code === "ENOENT" ? [fallback] : [];
    }
  }
  return [fallback];
}

function canonicalPath(value, context) {
  if (!value || !context.path.isAbsolute(value)) return undefined;
  try {
    return context.realpath(value);
  } catch {
    return undefined;
  }
}

function validTaskTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

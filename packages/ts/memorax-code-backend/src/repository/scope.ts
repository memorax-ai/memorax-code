import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const CODEX_PROJECTLESS_SLUG = "Codex-General";
const MAX_GIT_POINTER_BYTES = 64 * 1024;
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

export type RepositoryMemoryIdentitySource =
  | "origin-remote"
  | "git-common-dir"
  | "workspace-directory"
  | "codex-projectless";

export type RepositoryMemoryScopeKind = "git-repository" | "local-directory" | "codex-projectless";
export type RepositoryMemoryScopeFallbackReason = "git_metadata_invalid";

export type RepositoryMemoryScope = Readonly<{
  schemaVersion: "workspace-memory-scope.v1";
  baseUserId: string;
  effectiveUserId: string;
  repositoryKey: string;
  repositorySlug: string;
  repositoryName: string;
  identitySource: RepositoryMemoryIdentitySource;
  scopeKind: RepositoryMemoryScopeKind;
  fallbackReason?: RepositoryMemoryScopeFallbackReason;
  boundWorkspaceRoot?: string;
}>;

export type RepositoryMemoryScopeFailureReason =
  | "workspace_scope_unavailable"
  | "effective_user_id_invalid"
  | "workspace_scope_mismatch";

export type RepositoryMemoryScopeResult =
  | { ok: true; scope: RepositoryMemoryScope }
  | { ok: false; reason: RepositoryMemoryScopeFailureReason; error: string };

export async function resolveRepositoryMemoryScope(input: {
  workspaceRoot?: string;
  workspaceKind?: string;
  baseUserId: string;
}): Promise<RepositoryMemoryScopeResult> {
  const baseUserId = input.baseUserId.trim();
  if (!baseUserId) {
    return {
      ok: false,
      reason: "effective_user_id_invalid",
      error: "base MemoraX user id is required for workspace-scoped memory",
    };
  }

  const workspaceKind = input.workspaceKind?.trim().toLowerCase();
  if (workspaceKind === "projectless") {
    const workspace = await resolveWorkspace(input.workspaceRoot);
    return {
      ok: true,
      scope: memoryScope({
        baseUserId,
        repositoryKey: identityKey("codex-projectless", CODEX_PROJECTLESS_SLUG),
        repositorySlug: CODEX_PROJECTLESS_SLUG,
        identitySource: "codex-projectless",
        scopeKind: "codex-projectless",
        boundWorkspaceRoot: workspace,
      }),
    };
  }

  const workspace = await resolveWorkspace(input.workspaceRoot);
  if (!workspace) {
    return {
      ok: false,
      reason: "workspace_scope_unavailable",
      error: "a readable workspace directory is required for workspace-scoped memory",
    };
  }
  const gitRepository = await resolveGitRepository(workspace);
  if (gitRepository.kind === "invalid") {
    return {
      ok: false,
      reason: "workspace_scope_unavailable",
      error: "Git repository metadata is invalid or unavailable",
    };
  }
  if (gitRepository.kind === "repository") {
    return {
      ok: true,
      scope: memoryScope({
        baseUserId,
        repositoryKey: identityKey("git-common-dir", gitRepository.commonDir),
        repositorySlug: gitRepository.repositoryName,
        identitySource: gitRepository.identitySource,
        scopeKind: "git-repository",
        boundWorkspaceRoot: gitRepository.workspaceRoot,
      }),
    };
  }
  const localWorkspace = gitRepository.kind === "degraded"
    ? gitRepository.workspaceRoot
    : workspace;
  const workspaceName = sanitizeWorkspaceName(basename(localWorkspace));
  if (!workspaceName) {
    return {
      ok: false,
      reason: "workspace_scope_unavailable",
      error: "the workspace root must have a usable folder name",
    };
  }
  return {
    ok: true,
    scope: memoryScope({
      baseUserId,
      repositoryKey: identityKey("workspace-directory", localWorkspace),
      repositorySlug: workspaceName,
      identitySource: "workspace-directory",
      scopeKind: "local-directory",
      fallbackReason: gitRepository.kind === "degraded" ? gitRepository.reason : undefined,
      boundWorkspaceRoot: localWorkspace,
    }),
  };
}

export function repositoryMemoryScopesMatch(
  left: RepositoryMemoryScope,
  right: RepositoryMemoryScope,
): boolean {
  return left.repositoryKey === right.repositoryKey
    && left.baseUserId === right.baseUserId
    && left.effectiveUserId === right.effectiveUserId
    && left.fallbackReason === right.fallbackReason;
}

export function repositoryMemoryScopeCanUpgradeFromDegradedGit(
  previous: RepositoryMemoryScope,
  current: RepositoryMemoryScope,
): boolean {
  return previous.scopeKind === "local-directory"
    && previous.identitySource === "workspace-directory"
    && previous.fallbackReason === "git_metadata_invalid"
    && current.scopeKind === "git-repository"
    && current.fallbackReason === undefined
    && previous.baseUserId === current.baseUserId
    && previous.boundWorkspaceRoot !== undefined
    && previous.boundWorkspaceRoot === current.boundWorkspaceRoot;
}

export async function repositoryMemoryScopeContainsWorkspace(
  scope: RepositoryMemoryScope,
  workspaceRoot: string | undefined,
): Promise<boolean> {
  if (!scope.boundWorkspaceRoot || !workspaceRoot?.trim()) return false;
  const workspace = await resolveWorkspace(workspaceRoot);
  if (!workspace) return false;
  if (scope.scopeKind === "git-repository") {
    const gitRepository = await resolveGitRepository(workspace);
    return gitRepository.kind === "repository"
      && identityKey("git-common-dir", gitRepository.commonDir) === scope.repositoryKey
      && gitRepository.repositoryName === scope.repositorySlug;
  }
  if (!pathContains(scope.boundWorkspaceRoot, workspace)) return false;
  if (scope.scopeKind === "local-directory" && scope.fallbackReason === "git_metadata_invalid") {
    const gitRepository = await resolveGitRepository(workspace);
    return gitRepository.kind === "degraded"
      && identityKey("workspace-directory", gitRepository.workspaceRoot) === scope.repositoryKey;
  }
  return scope.scopeKind !== "local-directory"
    || !await hasGitMarkerBetween(workspace, scope.boundWorkspaceRoot);
}

export function repositoryMemoryScopeKind(scope: RepositoryMemoryScope): RepositoryMemoryScopeKind {
  return scope.scopeKind;
}

function memoryScope(input: {
  baseUserId: string;
  repositoryKey: string;
  repositorySlug: string;
  identitySource: RepositoryMemoryIdentitySource;
  scopeKind: RepositoryMemoryScopeKind;
  fallbackReason?: RepositoryMemoryScopeFallbackReason;
  boundWorkspaceRoot?: string;
}): RepositoryMemoryScope {
  return {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: input.baseUserId,
    effectiveUserId: `${input.baseUserId}@${input.repositorySlug}`,
    repositoryKey: input.repositoryKey,
    repositorySlug: input.repositorySlug,
    repositoryName: input.repositorySlug,
    identitySource: input.identitySource,
    scopeKind: input.scopeKind,
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    ...(input.boundWorkspaceRoot ? { boundWorkspaceRoot: input.boundWorkspaceRoot } : {}),
  };
}

function sanitizeWorkspaceName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[@/\\\s\p{Cc}]+/gu, "-")
    .replace(/[^\p{L}\p{N}._~-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return [...normalized].slice(0, 120).join("").replace(/-+$/g, "");
}

type GitRepositoryResolution =
  | { kind: "none" }
  | { kind: "invalid" }
  | {
    kind: "degraded";
    reason: RepositoryMemoryScopeFallbackReason;
    workspaceRoot: string;
  }
  | {
    kind: "repository";
    commonDir: string;
    repositoryName: string;
    identitySource: "origin-remote" | "git-common-dir";
    workspaceRoot: string;
  };

async function resolveGitRepository(workspace: string): Promise<GitRepositoryResolution> {
  let marker: { path: string; workspaceRoot: string } | undefined;
  try {
    marker = await findNearestGitMarker(workspace);
  } catch {
    return { kind: "invalid" };
  }
  if (!marker) return { kind: "none" };

  let directDirectoryMarker = false;
  try {
    const resolvedGitDir = await resolveGitDir(marker.path);
    directDirectoryMarker = resolvedGitDir.directDirectoryMarker;
    const gitDir = resolvedGitDir.path;
    await validateGitHead(gitDir);
    const commonDir = await resolveGitCommonDir(gitDir);
    await validateGitCommonDir(commonDir);
    const remotes = await readCommonConfigRemotes(commonDir);
    const remoteName = selectedRemoteRepositoryName(remotes);
    return {
      kind: "repository",
      commonDir,
      repositoryName: remoteName ?? repositoryNameFromCommonDir(commonDir),
      identitySource: remoteName ? "origin-remote" : "git-common-dir",
      workspaceRoot: marker.workspaceRoot,
    };
  } catch (error) {
    if (directDirectoryMarker && canFallbackFromDirectGitDirectory(error)) {
      return {
        kind: "degraded",
        reason: "git_metadata_invalid",
        workspaceRoot: marker.workspaceRoot,
      };
    }
    return { kind: "invalid" };
  }
}

async function findNearestGitMarker(
  workspace: string,
): Promise<{ path: string; workspaceRoot: string } | undefined> {
  let current = workspace;
  while (true) {
    const marker = join(current, ".git");
    try {
      await fs.lstat(marker);
      return { path: marker, workspaceRoot: current };
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function hasGitMarkerBetween(workspace: string, boundary: string): Promise<boolean> {
  let current = workspace;
  while (true) {
    try {
      await fs.lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) return true;
    }
    if (current === boundary) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

async function resolveGitDir(marker: string): Promise<{ path: string; directDirectoryMarker: boolean }> {
  const markerStat = await fs.lstat(marker);
  if (markerStat.isSymbolicLink()) {
    throw new GitMetadataValidationError("symbolic Git metadata marker is not allowed");
  }
  if (markerStat.isDirectory()) {
    return {
      path: await canonicalDirectory(marker),
      directDirectoryMarker: true,
    };
  }
  if (!markerStat.isFile()) throw new GitMetadataValidationError("invalid Git metadata marker");

  const line = await readSingleLine(marker, MAX_GIT_POINTER_BYTES);
  const match = /^gitdir:[ \t]*(.+)$/i.exec(line);
  const gitDir = match?.[1]?.trim();
  if (!gitDir) throw new GitMetadataValidationError("invalid Git metadata pointer");
  return {
    path: await canonicalDirectory(resolveMetadataPath(dirname(marker), gitDir)),
    directDirectoryMarker: false,
  };
}

async function resolveGitCommonDir(gitDir: string): Promise<string> {
  const path = join(gitDir, "commondir");
  try {
    await fs.lstat(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return gitDir;
    throw error;
  }
  const commonDir = (await readSingleLine(path, MAX_GIT_POINTER_BYTES)).trim();
  if (!commonDir) throw new GitMetadataValidationError("invalid Git common directory pointer");
  return await canonicalDirectory(resolveMetadataPath(gitDir, commonDir));
}

function resolveMetadataPath(base: string, value: string): string {
  if (value.includes("\0")) throw new GitMetadataValidationError("invalid Git metadata path");
  return isAbsolute(value) ? value : resolve(base, value);
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await fs.realpath(path);
  if (!(await fs.stat(canonical)).isDirectory()) {
    throw new GitMetadataValidationError("Git metadata path is not a directory");
  }
  return canonical;
}

async function validateGitHead(gitDir: string): Promise<void> {
  const head = (await readSingleLine(join(gitDir, "HEAD"), MAX_GIT_POINTER_BYTES)).trim();
  if (!/^ref: refs\/[^\0\r\n]+$/.test(head) && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(head)) {
    throw new GitMetadataValidationError("invalid Git HEAD");
  }
}

async function validateGitCommonDir(commonDir: string): Promise<void> {
  if (!(await fs.stat(join(commonDir, "objects"))).isDirectory()) {
    throw new GitMetadataValidationError("invalid Git objects directory");
  }
  const hasRefs = await isDirectory(join(commonDir, "refs"));
  const hasReftable = await isDirectory(join(commonDir, "reftable"));
  if (!hasRefs && !hasReftable) throw new GitMetadataValidationError("invalid Git references directory");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function readSingleLine(path: string, maxBytes: number): Promise<string> {
  let value = await readBoundedTextFile(path, maxBytes);
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (!value || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new GitMetadataValidationError("invalid single-line Git metadata");
  }
  return value;
}

async function readBoundedTextFile(path: string, maxBytes: number): Promise<string> {
  const file = await fs.stat(path);
  if (!file.isFile() || file.size > maxBytes) {
    throw new GitMetadataValidationError("invalid Git metadata file");
  }
  const value = await fs.readFile(path, "utf8");
  if (Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    throw new GitMetadataValidationError("invalid Git metadata file");
  }
  return value;
}

async function readCommonConfigRemotes(commonDir: string): Promise<Map<string, string>> {
  const path = join(commonDir, "config");
  let source: string;
  try {
    source = await readBoundedTextFile(path, MAX_GIT_CONFIG_BYTES);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return new Map();
    throw error;
  }
  return parseDirectRemoteUrls(source);
}

function parseDirectRemoteUrls(source: string): Map<string, string> {
  const remotes = new Map<string, string>();
  let remote: string | undefined;
  for (const line of logicalGitConfigLines(source)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (trimmed.startsWith("[")) {
      const section = parseGitConfigSection(trimmed);
      remote = section?.name.toLowerCase() === "remote" ? section.subsection : undefined;
      continue;
    }
    if (!remote) continue;
    const assignment = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=[ \t]*)?(.*)$/.exec(line);
    if (!assignment) throw new GitMetadataValidationError("invalid Git config assignment");
    if (assignment[1]?.toLowerCase() !== "url") continue;
    remotes.set(remote, parseGitConfigValue(assignment[2] ?? ""));
  }
  return remotes;
}

function logicalGitConfigLines(source: string): string[] {
  const lines: string[] = [];
  let pending = "";
  for (const physical of source.split("\n")) {
    const line = physical.endsWith("\r") ? physical.slice(0, -1) : physical;
    const combined = `${pending}${line}`;
    if (hasUnescapedTrailingBackslash(combined)) {
      pending = combined.slice(0, -1);
    } else {
      lines.push(combined);
      pending = "";
    }
  }
  if (pending) throw new GitMetadataValidationError("unterminated Git config continuation");
  return lines;
}

function hasUnescapedTrailingBackslash(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index -= 1) count += 1;
  return count % 2 === 1;
}

function parseGitConfigSection(line: string): { name: string; subsection?: string } {
  const match = /^\[[ \t]*([A-Za-z0-9][A-Za-z0-9.-]*)[ \t]*(?:"((?:[^"\\]|\\.)*)")?[ \t]*\](?:[ \t]*[#;].*)?$/.exec(line);
  if (!match?.[1]) throw new GitMetadataValidationError("invalid Git config section");
  if (!match[2] && match[1].includes(".")) {
    const separator = match[1].indexOf(".");
    return {
      name: match[1].slice(0, separator),
      subsection: match[1].slice(separator + 1),
    };
  }
  return {
    name: match[1],
    ...(match[2] !== undefined ? { subsection: unescapeGitConfigText(match[2]) } : {}),
  };
}

function parseGitConfigValue(value: string): string {
  const input = value.trimStart();
  if (!input.startsWith('"')) {
    const comment = input.search(/[#;]/);
    return unescapeGitConfigText((comment >= 0 ? input.slice(0, comment) : input).trimEnd());
  }

  let result = "";
  let escaped = false;
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index] as string;
    if (escaped) {
      result += unescapeGitConfigCharacter(character);
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') {
      result += character;
      continue;
    }
    const trailing = input.slice(index + 1).trim();
    if (trailing && !trailing.startsWith("#") && !trailing.startsWith(";")) {
      throw new GitMetadataValidationError("invalid Git config value");
    }
    return result;
  }
  throw new GitMetadataValidationError("unterminated Git config value");
}

function unescapeGitConfigText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) throw new GitMetadataValidationError("invalid Git config escape");
    result += unescapeGitConfigCharacter(escaped);
    index += 1;
  }
  return result;
}

function unescapeGitConfigCharacter(value: string): string {
  if (value === "n") return "\n";
  if (value === "t") return "\t";
  if (value === "b") return "\b";
  if (value === '"' || value === "\\") return value;
  throw new GitMetadataValidationError("invalid Git config escape");
}

function selectedRemoteRepositoryName(remotes: Map<string, string>): string | undefined {
  const origin = remotes.get("origin");
  if (origin !== undefined) return repositoryNameFromRemoteUrl(origin);
  if (remotes.size !== 1) return undefined;
  return repositoryNameFromRemoteUrl(remotes.values().next().value ?? "");
}

function repositoryNameFromRemoteUrl(value: string): string | undefined {
  const raw = value.trim();
  if (
    !raw
    || raw.startsWith("/")
    || raw.startsWith("./")
    || raw.startsWith("../")
    || raw.startsWith("\\\\")
    || /^[a-zA-Z]:[\\/]/.test(raw)
  ) return undefined;

  try {
    const parsed = new URL(raw);
    if (!["http:", "https:", "ssh:", "git:", "git+ssh:", "git+https:"].includes(parsed.protocol)) {
      return undefined;
    }
    if (!parsed.hostname.trim()) return undefined;
    return repositoryNameFromRemotePath(parsed.pathname);
  } catch {
    const scp = /^(?:[^@/:\s]+@)?[^/:\s]+:(.+)$/.exec(raw);
    return scp?.[1] ? repositoryNameFromRemotePath(scp[1]) : undefined;
  }
}

function repositoryNameFromRemotePath(value: string): string | undefined {
  const path = value
    .split(/[?#]/, 1)[0]
    ?.replace(/[\\/]+$/, "");
  let name = path?.split(/[\\/]/).filter(Boolean).at(-1);
  if (!name) return undefined;
  try {
    name = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  name = name.replace(/\.git$/i, "");
  return sanitizeWorkspaceName(name) || undefined;
}

function repositoryNameFromCommonDir(commonDir: string): string {
  const commonName = basename(commonDir);
  const name = commonName.toLowerCase() === ".git"
    ? basename(dirname(commonDir))
    : commonName.replace(/\.git$/i, "");
  const normalized = sanitizeWorkspaceName(name);
  if (!normalized) throw new GitMetadataValidationError("Git common directory has no usable repository name");
  return normalized;
}

function identityKey(source: RepositoryMemoryIdentitySource, value: string): string {
  return createHash("sha256").update(`${source}:${value}`).digest("hex");
}

async function resolveWorkspace(value: string | undefined): Promise<string | undefined> {
  if (!value?.trim()) return undefined;
  try {
    const path = await fs.realpath(value);
    return (await fs.stat(path)).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

function pathContains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

class GitMetadataValidationError extends Error {}

function canFallbackFromDirectGitDirectory(error: unknown): boolean {
  return error instanceof GitMetadataValidationError
    || isNodeErrorCode(error, "ENOENT")
    || isNodeErrorCode(error, "ENOTDIR");
}

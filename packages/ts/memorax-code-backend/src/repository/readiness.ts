import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { memoryProjectRoot } from "../memory/project.js";

const execFileAsync = promisify(execFile);
const STABLE_READINESS_CACHE_TTL_MS = 30_000;
const PREPARING_READINESS_CACHE_TTL_MS = 5_000;
const UNRESOLVED_READINESS_CACHE_TTL_MS = 10_000;
const READINESS_CACHE_CAPACITY = 256;
export const REPO_MEMORY_READINESS_MAX_CONCURRENT_VALIDATIONS = 4;
const readinessCache = new Map<string, { expiresAt: number; value: RepoMemoryReadiness }>();
const readinessInFlight = new Map<string, Promise<RepoMemoryReadiness>>();
const dependencyScopes = new WeakMap<object, number>();
const validationWaiters: Array<() => void> = [];
let nextDependencyScope = 1;
let activeBundleValidations = 0;

export type RepoMemoryReadinessStatus = "ready" | "preparing" | "not_ready" | "unknown";
export type RepoMemoryReadinessReason =
  | "usable"
  | "active_job"
  | "bundle_missing"
  | "bundle_invalid"
  | "project_unresolved"
  | "validator_unavailable";

export type RepoMemoryReadiness = Readonly<{
  status: RepoMemoryReadinessStatus;
  reason: RepoMemoryReadinessReason;
}>;

type ActiveJobReader = (input: {
  memoraxCodeHome: string;
  repoRealpath: string;
}) => Promise<{ active: boolean }>;

type BundleValidator = (repoRoot: string) => Promise<"usable" | "missing" | "invalid" | "unknown">;

export type RepoMemoryReadinessDependencies = Readonly<{
  resolveProjectRoot?: (projectId: string) => string | undefined;
  readActiveJob?: ActiveJobReader;
  validateBundle?: BundleValidator;
}>;

const DEFAULT_READINESS_DEPENDENCIES: RepoMemoryReadinessDependencies = Object.freeze({});

export async function repoMemoryReadinessForProject(
  projectId: string,
  memoraxCodeHome: string,
  dependencies: RepoMemoryReadinessDependencies = DEFAULT_READINESS_DEPENDENCIES,
): Promise<RepoMemoryReadiness> {
  const cacheKey = readinessCacheKey(projectId, memoraxCodeHome, dependencies);
  const cached = readCachedReadiness(cacheKey);
  if (cached) return cached;

  const pending = readinessInFlight.get(cacheKey);
  if (pending) return pending;

  const request = resolveRepoMemoryReadiness(projectId, memoraxCodeHome, dependencies)
    .then((value) => {
      cacheReadiness(cacheKey, value);
      return value;
    })
    .finally(() => {
      if (readinessInFlight.get(cacheKey) === request) readinessInFlight.delete(cacheKey);
    });
  readinessInFlight.set(cacheKey, request);
  return request;
}

function readinessCacheKey(
  projectId: string,
  memoraxCodeHome: string,
  dependencies: RepoMemoryReadinessDependencies,
): string {
  if (dependencies === DEFAULT_READINESS_DEPENDENCIES) {
    return `default\u0000${memoraxCodeHome}\u0000${projectId}`;
  }
  let scope = dependencyScopes.get(dependencies);
  if (scope === undefined) {
    scope = nextDependencyScope;
    nextDependencyScope += 1;
    dependencyScopes.set(dependencies, scope);
  }
  return `dependencies:${scope}\u0000${memoraxCodeHome}\u0000${projectId}`;
}

function readCachedReadiness(cacheKey: string): RepoMemoryReadiness | undefined {
  const cached = readinessCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    readinessCache.delete(cacheKey);
    return undefined;
  }
  readinessCache.delete(cacheKey);
  readinessCache.set(cacheKey, cached);
  return cached.value;
}

function cacheReadiness(cacheKey: string, value: RepoMemoryReadiness): void {
  const now = Date.now();
  for (const [key, cached] of readinessCache) {
    if (cached.expiresAt <= now) readinessCache.delete(key);
  }
  while (readinessCache.size >= READINESS_CACHE_CAPACITY) {
    const oldest = readinessCache.keys().next().value;
    if (typeof oldest !== "string") break;
    readinessCache.delete(oldest);
  }
  readinessCache.delete(cacheKey);
  readinessCache.set(cacheKey, { expiresAt: now + readinessCacheTtl(value), value });
}

function readinessCacheTtl(value: RepoMemoryReadiness): number {
  if (value.status === "preparing") return PREPARING_READINESS_CACHE_TTL_MS;
  if (value.reason === "project_unresolved") return UNRESOLVED_READINESS_CACHE_TTL_MS;
  return STABLE_READINESS_CACHE_TTL_MS;
}

async function resolveRepoMemoryReadiness(
  projectId: string,
  memoraxCodeHome: string,
  dependencies: RepoMemoryReadinessDependencies,
): Promise<RepoMemoryReadiness> {
  const repoRoot = (dependencies.resolveProjectRoot ?? memoryProjectRoot)(projectId);
  if (!repoRoot) return { status: "unknown", reason: "project_unresolved" };

  try {
    const active = await (dependencies.readActiveJob ?? readActiveRepoMemoryJob)({
      memoraxCodeHome,
      repoRealpath: repoRoot,
    });
    if (active.active) return { status: "preparing", reason: "active_job" };
  } catch {
    // Bundle validation remains useful when the optional job marker cannot be read.
  }

  const validateBundle = dependencies.validateBundle ?? validateRepoMemoryBundle;
  const bundle = await withBundleValidationSlot(() => validateBundle(repoRoot));
  if (bundle === "usable") return { status: "ready", reason: "usable" };
  if (bundle === "missing") return { status: "not_ready", reason: "bundle_missing" };
  if (bundle === "invalid") return { status: "not_ready", reason: "bundle_invalid" };
  return { status: "unknown", reason: "validator_unavailable" };
}

async function withBundleValidationSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquireBundleValidationSlot();
  try {
    return await task();
  } finally {
    releaseBundleValidationSlot();
  }
}

async function acquireBundleValidationSlot(): Promise<void> {
  if (activeBundleValidations < REPO_MEMORY_READINESS_MAX_CONCURRENT_VALIDATIONS) {
    activeBundleValidations += 1;
    return;
  }
  await new Promise<void>((resolve) => validationWaiters.push(resolve));
}

function releaseBundleValidationSlot(): void {
  const next = validationWaiters.shift();
  if (next) {
    // The released slot transfers directly to the oldest waiter.
    next();
    return;
  }
  activeBundleValidations -= 1;
}

async function readActiveRepoMemoryJob(input: {
  memoraxCodeHome: string;
  repoRealpath: string;
}): Promise<{ active: boolean }> {
  const moduleUrl = new URL(
    "../../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs",
    import.meta.url,
  );
  const markerModule = await import(moduleUrl.href) as {
    readActiveRepoMemoryJobMarker?: (value: typeof input) => { active: boolean };
  };
  if (typeof markerModule.readActiveRepoMemoryJobMarker !== "function") {
    throw new Error("repo memory job marker reader is unavailable");
  }
  return markerModule.readActiveRepoMemoryJobMarker(input);
}

async function validateRepoMemoryBundle(
  repoRoot: string,
): Promise<"usable" | "missing" | "invalid" | "unknown"> {
  const profileUrl = new URL(".repo_memory/PROFILE.md", pathToDirectoryUrl(repoRoot));
  try {
    await access(profileUrl, constants.R_OK);
  } catch {
    return "missing";
  }

  const validatorUrl = new URL(
    "../../../memorax-code-codex-adapter/skills/memorax-code/scripts/validate_memory.py",
    import.meta.url,
  );
  try {
    await access(validatorUrl, constants.R_OK);
  } catch {
    return "unknown";
  }

  const python = process.env.MEMORAX_CODE_REPO_MEMORY_PYTHON_COMMAND || "python3";
  try {
    const { stdout } = await execFileAsync(python, [fileURLToPath(validatorUrl), repoRoot], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return readinessFromValidatorOutput(stdout);
  } catch (error) {
    const stdout = typeof (error as { stdout?: unknown })?.stdout === "string"
      ? (error as { stdout: string }).stdout
      : "";
    const outcome = readinessFromValidatorOutput(stdout);
    return outcome === "invalid" ? "invalid" : "unknown";
  }
}

function readinessFromValidatorOutput(value: string): "usable" | "invalid" | "unknown" {
  try {
    const report = JSON.parse(value) as { ok?: unknown };
    return report.ok === true ? "usable" : report.ok === false ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

function pathToDirectoryUrl(path: string): URL {
  const normalized = path.endsWith("/") ? path : `${path}/`;
  return pathToFileURL(normalized);
}

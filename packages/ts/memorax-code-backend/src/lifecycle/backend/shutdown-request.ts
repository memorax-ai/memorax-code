import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type BackendShutdownTarget = Readonly<{
  pid: number;
  instanceId: string;
}>;

export type BackendShutdownRequestWatcher = Readonly<{
  close(): void;
}>;

type BackendShutdownRequest = BackendShutdownTarget & {
  version: 1;
  requestedAt: string;
};

type BackendShutdownRequestWatcherOptions = BackendShutdownTarget & {
  memoraxCodeHome: string;
  onShutdown(): void | Promise<void>;
  onError?(error: unknown): void;
};

const BACKEND_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const BACKEND_SHUTDOWN_REQUEST_POLL_INTERVAL_MS = 50;

export function backendShutdownRequestPath(memoraxCodeHome: string): string {
  return join(memoraxCodeHome, "runtime", "backend", "backend.shutdown.json");
}

export function writeBackendShutdownRequest(
  memoraxCodeHome: string,
  target: BackendShutdownTarget,
): string {
  assertShutdownTarget(target);
  const path = backendShutdownRequestPath(memoraxCodeHome);
  const directory = join(memoraxCodeHome, "runtime", "backend");
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const request: BackendShutdownRequest = {
    version: 1,
    pid: target.pid,
    instanceId: target.instanceId,
    requestedAt: new Date().toISOString(),
  };
  mkdirSync(directory, { recursive: true });
  rmSync(path, { force: true });
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(request, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return path;
}

export function clearBackendShutdownRequest(memoraxCodeHome: string): void {
  rmSync(backendShutdownRequestPath(memoraxCodeHome), { force: true });
}

export function startBackendShutdownRequestWatcher(
  options: BackendShutdownRequestWatcherOptions,
): BackendShutdownRequestWatcher {
  assertShutdownTarget(options);
  const path = backendShutdownRequestPath(options.memoraxCodeHome);
  const directory = dirname(path);
  let closed = false;
  let accepted = false;
  let watching = false;

  function invokeShutdown() {
    if (closed) return;
    void Promise.resolve(options.onShutdown()).catch((error) => {
      options.onError?.(error);
    });
  }
  function stopWatching() {
    if (!watching) return;
    watching = false;
    unwatchFile(path, inspect);
  }
  function inspect() {
    if (closed || accepted) return;
    try {
      if (!takeMatchingShutdownRequest(path, options)) return;
      accepted = true;
      stopWatching();
      queueMicrotask(invokeShutdown);
    } catch (error) {
      options.onError?.(error);
    }
  }

  mkdirSync(directory, { recursive: true });
  inspect();
  if (!accepted) {
    watching = true;
    // Directory fs.watch events may be coalesced or dropped. Poll the exact
    // request path so a graceful Windows shutdown cannot depend on one event.
    watchFile(path, {
      persistent: false,
      interval: BACKEND_SHUTDOWN_REQUEST_POLL_INTERVAL_MS,
    }, inspect);
    // Close the gap between the initial inspection and polling registration.
    inspect();
  }
  return {
    close() {
      if (closed) return;
      closed = true;
      stopWatching();
      clearBackendShutdownRequest(options.memoraxCodeHome);
    },
  };
}

function takeMatchingShutdownRequest(
  path: string,
  target: BackendShutdownTarget,
): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  rmSync(path, { force: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isShutdownRequest(parsed)) return false;
  return parsed.pid === target.pid && parsed.instanceId === target.instanceId;
}

function isShutdownRequest(value: unknown): value is BackendShutdownRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.version === 1
    && Number.isSafeInteger(request.pid)
    && (request.pid as number) > 0
    && typeof request.instanceId === "string"
    && BACKEND_INSTANCE_ID_PATTERN.test(request.instanceId)
    && typeof request.requestedAt === "string"
    && Number.isFinite(Date.parse(request.requestedAt));
}

function assertShutdownTarget(target: BackendShutdownTarget): void {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
    throw new TypeError("Backend shutdown target PID must be a positive safe integer");
  }
  if (!BACKEND_INSTANCE_ID_PATTERN.test(target.instanceId)) {
    throw new TypeError("Backend shutdown target instanceId is invalid");
  }
}

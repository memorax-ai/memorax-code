import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withJsonFileLockAsync } from "../../../memorax-code-adapter-common/src/config-utils.mjs";
import type { BackendServiceOptions } from "./contracts.js";

const BACKEND_LIFECYCLE_LOCK_TIMEOUT_MS = 25000;
const BACKEND_LIFECYCLE_LOCK_STALE_MS = 5000;
const BACKEND_LIFECYCLE_LOCK_RETRY_MS = 20;

export class BackendLifecycleLockError extends Error {
  readonly code: "BACKEND_LIFECYCLE_LOCK_TIMEOUT" | "BACKEND_LIFECYCLE_LOCK_FAILED";
  readonly lockPath: string;

  constructor(lockPath: string, cause?: unknown) {
    super(cause === undefined
      ? `timed out waiting for Backend lifecycle authority lock: ${lockPath}`
      : `failed to acquire Backend lifecycle authority lock: ${lockPath}`, { cause });
    this.code = cause === undefined ? "BACKEND_LIFECYCLE_LOCK_TIMEOUT" : "BACKEND_LIFECYCLE_LOCK_FAILED";
    this.name = "BackendLifecycleLockError";
    this.lockPath = lockPath;
  }
}

export function backendServiceHome(options: BackendServiceOptions = {}): string {
  // The detached Backend changes cwd; resolve once in the caller's directory.
  return resolve(options.home ?? process.env.MEMORAX_CODE_HOME ?? join(homedir(), ".memorax-code"));
}

export function backendLifecycleLockTarget(options: BackendServiceOptions = {}): string {
  return join(backendServiceHome(options), "runtime", "backend", "backend.lifecycle");
}

export async function withBackendLifecycleLock<T>(
  options: BackendServiceOptions,
  operation: () => T | Promise<T>,
): Promise<T> {
  const target = backendLifecycleLockTarget(options);
  let entered = false;
  try {
    return await withJsonFileLockAsync(target, () => {
      entered = true;
      return operation();
    }, {
      timeoutMs: BACKEND_LIFECYCLE_LOCK_TIMEOUT_MS,
      staleMs: BACKEND_LIFECYCLE_LOCK_STALE_MS,
      retryMs: BACKEND_LIFECYCLE_LOCK_RETRY_MS,
    });
  } catch (error) {
    // An operation can acquire other locks; its failures retain their owner.
    if (entered) throw error;
    if (errorCode(error) === "JSON_FILE_LOCK_TIMEOUT") {
      throw new BackendLifecycleLockError(`${target}.lock`);
    }
    throw new BackendLifecycleLockError(`${target}.lock`, error);
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

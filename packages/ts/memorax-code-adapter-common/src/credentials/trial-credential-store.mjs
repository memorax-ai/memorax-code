import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withJsonFileLockAsync } from "../config-utils.mjs";
import { createLinuxSecretServiceBackend } from "./linux-secret-service.mjs";
import { createMacosKeychainBackend } from "./macos-keychain.mjs";
import {
  SecureCredentialBackendError,
  secureCredentialBackendError,
} from "./secure-command.mjs";
import {
  completeTrialCredentialProvisioning,
  TrialCredentialRecordError,
  parseTrialCredentialRecord,
  serializeTrialCredentialRecord,
  validateTrialCredentialRecord,
} from "./trial-credential-record.mjs";
import { createWindowsDpapiBackend } from "./windows-dpapi.mjs";

const STORE_BACKEND = "credential-store";
const HOME_NAMESPACE_DOMAIN = "memorax-code:trial-credential-home:v1\0";

export function trialCredentialNamespace(memoraxCodeHome, options) {
  const platform = options?.platform ?? process.platform;
  const resolveHome = options?.resolveHome ?? resolve;
  const home = normalizedHome(memoraxCodeHome, resolveHome);
  const identity = platform === "win32" ? home.toLowerCase() : home;
  return createHash("sha256")
    .update(HOME_NAMESPACE_DOMAIN, "utf8")
    .update(identity, "utf8")
    .digest("hex");
}

export function trialCredentialLockPath(memoraxCodeHome) {
  return join(normalizedHome(memoraxCodeHome, resolve), "runtime", "credentials", "trial-credentials");
}

export function trialCredentialProvisionLockPath(memoraxCodeHome) {
  return join(normalizedHome(memoraxCodeHome, resolve), "runtime", "credentials", "trial-provision");
}

export async function withTrialCredentialProvisionLock(operation, options = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("Trial credential provisioning lock requires an operation");
  }
  const home = resolveStoreHome(options);
  return await withJsonFileLockAsync(
    trialCredentialProvisionLockPath(home),
    operation,
    options.provisionLockOptions ?? options.lockOptions,
  );
}

export function createTrialCredentialStorePort(options = {}) {
  const configured = isRecord(options) ? { ...options } : {};
  const configuredProvisionLockOptions = isRecord(configured.provisionLockOptions)
    ? { ...configured.provisionLockOptions }
    : isRecord(configured.lockOptions)
      ? { ...configured.lockOptions }
      : {};
  return Object.freeze({
    load: () => loadTrialCredentialRecord(configured),
    createIfAbsent: (value) => createTrialCredentialRecordIfAbsent(value, configured),
    complete: (value, metadata) => completeTrialCredentialRecord(value, metadata, configured),
    withProvisionLock(operation, lockOptions = {}) {
      if (!isRecord(lockOptions)) {
        throw new TypeError("Trial credential provisioning lock requires valid options");
      }
      return withTrialCredentialProvisionLock(operation, {
        ...configured,
        provisionLockOptions: {
          ...configuredProvisionLockOptions,
          ...lockOptions,
        },
      });
    },
  });
}

function createTrialCredentialBackend(options = {}) {
  const home = resolveStoreHome(options);
  const platform = options.platform ?? process.platform;
  const namespace = trialCredentialNamespace(home, { platform });
  if (options.backend !== undefined) return validateBackend(options.backend);
  const runtime = isRecord(options.runtime) ? options.runtime : {};
  const backendOptions = {
    ...runtime,
    namespace,
    environment: options.env ?? runtime.environment ?? process.env,
  };
  if (platform === "darwin") return createMacosKeychainBackend(backendOptions);
  if (platform === "linux") return createLinuxSecretServiceBackend(backendOptions);
  if (platform === "win32") return createWindowsDpapiBackend(backendOptions);
  throw secureCredentialBackendError(STORE_BACKEND, "initialize", "backend_unavailable");
}

export async function loadTrialCredentialRecord(options = {}) {
  const backend = createTrialCredentialBackend(options);
  return loadFromBackend(backend, "load");
}

export async function createTrialCredentialRecordIfAbsent(value, options = {}) {
  const candidate = validateTrialCredentialRecord(value);
  if (!isProvisioningSeed(candidate)) {
    throw new TrialCredentialRecordError("invalid_transition");
  }
  const home = resolveStoreHome(options);
  const backend = createTrialCredentialBackend({ ...options, memoraxCodeHome: home });
  return withJsonFileLockAsync(
    trialCredentialLockPath(home),
    async () => {
      const current = await loadFromBackend(backend, "load");
      if (current !== null) {
        return Object.freeze({ record: current, created: false });
      }
      const stored = await saveVerifiedRecord(backend, candidate);
      return Object.freeze({ record: stored, created: true });
    },
    options.lockOptions,
  );
}

export async function completeTrialCredentialRecord(value, metadata, options = {}) {
  const expected = serializeTrialCredentialRecord(value);
  const home = resolveStoreHome(options);
  const backend = createTrialCredentialBackend({ ...options, memoraxCodeHome: home });
  return withJsonFileLockAsync(
    trialCredentialLockPath(home),
    async () => {
      const current = await loadFromBackend(backend, "load");
      if (current === null || serializeTrialCredentialRecord(current) !== expected) {
        throw new TrialCredentialRecordError("invalid_transition");
      }
      let next;
      try {
        next = completeTrialCredentialProvisioning(current, metadata);
      } catch (error) {
        const reason = error instanceof TrialCredentialRecordError
          ? error.reason
          : "invalid_transition";
        throw new TrialCredentialRecordError(reason);
      }
      return saveVerifiedRecord(backend, next);
    },
    options.lockOptions,
  );
}

export async function clearTrialCredentialRecord(options = {}) {
  return await withTrialCredentialProvisionLock(
    () => clearTrialCredentialRecordLocked(options),
    options,
  );
}

async function clearTrialCredentialRecordLocked(options) {
  const home = resolveStoreHome(options);
  const backend = createTrialCredentialBackend({ ...options, memoraxCodeHome: home });
  return withJsonFileLockAsync(
    trialCredentialLockPath(home),
    async () => {
      let deleted;
      try {
        deleted = await backend.delete();
      } catch (error) {
        throw sanitizedBackendError(error, "delete");
      }
      if (typeof deleted !== "boolean") {
        throw secureCredentialBackendError(STORE_BACKEND, "delete", "invalid_response");
      }
      const remaining = await loadSerialized(backend, "verify-delete");
      if (remaining !== null) {
        throw secureCredentialBackendError(STORE_BACKEND, "delete", "storage_failed");
      }
      return { deleted };
    },
    options.lockOptions,
  );
}

function resolveStoreHome(options) {
  const env = isRecord(options?.env) ? options.env : process.env;
  const configured = nonEmptyString(options?.memoraxCodeHome)
    ?? nonEmptyString(env.MEMORAX_CODE_HOME)
    ?? join(homedir(), ".memorax-code");
  return normalizedHome(configured, resolve);
}

function normalizedHome(value, resolveHome) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError("Trial credential store requires a valid MemoraX Code home");
  }
  try {
    const resolved = resolveHome(value.trim());
    if (typeof resolved !== "string" || !resolved || resolved.includes("\0")) {
      throw new TypeError();
    }
    return resolved;
  } catch {
    throw new TypeError("Trial credential store requires a valid MemoraX Code home");
  }
}

function validateBackend(backend) {
  if (!isRecord(backend)
    || typeof backend.load !== "function"
    || typeof backend.save !== "function"
    || typeof backend.delete !== "function") {
    throw secureCredentialBackendError(STORE_BACKEND, "initialize", "backend_unavailable");
  }
  return backend;
}

async function loadFromBackend(backend, operation) {
  const serialized = await loadSerialized(backend, operation);
  return serialized === null ? null : parseTrialCredentialRecord(serialized);
}

async function loadSerialized(backend, operation) {
  let serialized;
  try {
    serialized = await backend.load();
  } catch (error) {
    throw sanitizedBackendError(error, operation);
  }
  if (serialized === null) return null;
  if (typeof serialized !== "string") {
    throw secureCredentialBackendError(STORE_BACKEND, operation, "invalid_response");
  }
  return serialized;
}

async function saveToBackend(backend, serialized) {
  try {
    const result = await backend.save(serialized);
    if (result !== undefined) {
      throw secureCredentialBackendError(STORE_BACKEND, "save", "invalid_response");
    }
  } catch (error) {
    throw sanitizedBackendError(error, "save");
  }
}

async function saveVerifiedRecord(backend, record, serialized = undefined) {
  const expected = serialized ?? serializeTrialCredentialRecord(record);
  await saveToBackend(backend, expected);
  const stored = await loadFromBackend(backend, "verify");
  if (stored === null || serializeTrialCredentialRecord(stored) !== expected) {
    throw secureCredentialBackendError(STORE_BACKEND, "save", "storage_failed");
  }
  return stored;
}

function sanitizedBackendError(error, operation) {
  const reason = error instanceof SecureCredentialBackendError
    ? error.reason
    : "command_failed";
  return secureCredentialBackendError(STORE_BACKEND, operation, reason);
}

function isProvisioningSeed(record) {
  return record.state === "provisioning" && record.account_id === null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

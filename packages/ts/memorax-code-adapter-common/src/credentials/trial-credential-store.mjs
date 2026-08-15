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

export async function transitionTrialCredentialRecord(operation, options = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("Trial credential mutation requires an operation");
  }
  const home = resolveStoreHome(options);
  const backend = createTrialCredentialBackend({ ...options, memoraxCodeHome: home });
  return withJsonFileLockAsync(
    trialCredentialLockPath(home),
    async () => {
      const current = await loadFromBackend(backend, "load");
      if (current === null) {
        throw new TrialCredentialRecordError("invalid_transition");
      }
      let candidate;
      try {
        candidate = operation(current);
      } catch (error) {
        throw sanitizedMutationError(error);
      }
      if (isThenable(candidate)) {
        suppressRejectedPromise(candidate);
        throw new TypeError("Trial credential mutation must be synchronous");
      }
      if (candidate === undefined) return current;

      const next = validateTrialCredentialRecord(candidate);
      const serialized = serializeTrialCredentialRecord(next);
      if (serializeTrialCredentialRecord(current) === serialized) {
        return current;
      }
      assertStoredTransition(current, next);
      return saveVerifiedRecord(backend, next, serialized);
    },
    options.lockOptions,
  );
}

export async function clearTrialCredentialRecord(options = {}) {
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
  let reason = "command_failed";
  try {
    if (error instanceof SecureCredentialBackendError) reason = error.reason;
  } catch {
    reason = "command_failed";
  }
  return secureCredentialBackendError(STORE_BACKEND, operation, reason);
}

function sanitizedMutationError(error) {
  let reason = "invalid_transition";
  try {
    if (error instanceof TrialCredentialRecordError) reason = error.reason;
  } catch {
    reason = "invalid_transition";
  }
  return new TrialCredentialRecordError(reason);
}

function isThenable(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return typeof value.then === "function";
  } catch {
    throw new TrialCredentialRecordError("invalid_transition");
  }
}

function suppressRejectedPromise(value) {
  try {
    if (value instanceof Promise) {
      void Promise.prototype.catch.call(value, () => undefined);
    }
  } catch {
    // Best effort: the fixed synchronous-mutation error remains authoritative.
  }
}

function isProvisioningSeed(record) {
  return (record.state === "provisioning" || record.state === "recovering")
    && record.account_id === null;
}

function assertStoredTransition(current, next) {
  if (current.plugin_mark !== next.plugin_mark) invalidTransition();

  if (current.state === "provisioning") {
    if (next.state !== "ready" || current.api_key !== next.api_key) invalidTransition();
    return;
  }

  if (current.state === "ready") {
    if (next.state === "ready") {
      if (current.api_key !== next.api_key
        || current.account_id !== next.account_id
        || current.project_id !== next.project_id) {
        invalidTransition();
      }
      assertWarningPolicyReset(current, next);
      return;
    }
    if (next.state === "recovering"
      && current.api_key !== next.api_key
      && sameFields(current, next, [
        "account_id",
        "project_id",
        "warn_remaining_threshold",
        "warn_remaining_step",
        "register_url",
        "last_warned_level",
      ])) {
      return;
    }
    invalidTransition();
  }

  if (current.state === "recovering") {
    if (next.state !== "ready" || current.api_key !== next.api_key) invalidTransition();
    if (current.account_id !== null
      && (current.account_id !== next.account_id || current.project_id !== next.project_id)) {
      invalidTransition();
    }
    assertWarningPolicyReset(current, next);
    return;
  }

  invalidTransition();
}

function assertWarningPolicyReset(current, next) {
  if (current.warn_remaining_threshold !== null
    && (current.warn_remaining_threshold !== next.warn_remaining_threshold
      || current.warn_remaining_step !== next.warn_remaining_step)
    && next.last_warned_level !== null) {
    invalidTransition();
  }
}

function sameFields(left, right, fields) {
  return fields.every((field) => left[field] === right[field]);
}

function invalidTransition() {
  throw new TrialCredentialRecordError("invalid_transition");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

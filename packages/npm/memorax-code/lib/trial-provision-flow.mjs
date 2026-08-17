import {
  TrialProvisionClientError,
} from "./trial-provision-client.mjs";
import { generateTrialPluginIdentity } from "./trial-plugin-mark.mjs";

export {
  generateTrialPluginIdentity,
  generateTrialMarkId,
} from "./trial-plugin-mark.mjs";

const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_HTTP_REQUESTS = 5;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_UNCERTAIN_SUCCESS_RETRIES = 1;
const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);
const MAX_JITTER_MS = 250;
const MARK_IDENTITY_FIELDS = Object.freeze([
  "mark_id",
  "mark_version",
  "app_salt",
  "machine_id",
  "hostname",
  "platform",
  "arch",
  "mac_hash",
]);
const CREDENTIAL_FIELDS = Object.freeze([
  "version",
  "state",
  ...MARK_IDENTITY_FIELDS,
  "api_key",
  "account_id",
  "project_id",
  "last_warned_write_level",
  "last_warned_search_level",
]);
const MARK_ID_PATTERN = /^mk_[0-9a-f]{64}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;
const FLOW_ERROR_REASONS = new Set([
  "invalid_options",
  "invalid_credential_state",
  "identity_generation_failed",
  "credential_failure",
  "credential_conflict",
  "response_state_mismatch",
  "deadline_exceeded",
  "http_budget_exhausted",
  "aborted",
  "client_failure",
  "retry_failed",
]);

export class TrialProvisionFlowError extends Error {
  constructor(reason) {
    const safeReason = FLOW_ERROR_REASONS.has(reason) ? reason : "client_failure";
    super(`Trial provision flow failed (${safeReason})`);
    this.name = "TrialProvisionFlowError";
    this.code = "TRIAL_PROVISION_FLOW_FAILED";
    this.reason = safeReason;
  }
}

export async function ensureTrialCredentialReady(options = {}) {
  const runtime = validateOptions(options);
  const deadline = createFlowDeadline(runtime);
  try {
    assertActive(deadline.context);
    return await runtime.credentialPort.withProvisionLock(
      () => runTrialCredentialFlow(deadline.context),
      {
        signal: deadline.context.signal,
        timeoutMs: Math.max(1, Math.ceil(remainingTime(deadline.context))),
      },
    );
  } catch (error) {
    throwIfInterrupted(deadline.context);
    if (error instanceof TrialProvisionFlowError
      || error instanceof TrialProvisionClientError) {
      throw error;
    }
    throw flowError("credential_failure");
  } finally {
    clearTimeout(deadline.timer);
  }
}

async function runTrialCredentialFlow(context) {
  let record = await loadCredential(context);
  if (record === null) record = await createCredential(context);
  assertActive(context);
  assertCredentialRecord(record);
  if (record.state === "ready") return readyResult(record, false);

  const snapshot = snapshotCredential(record);
  const response = await provisionWithRetry(snapshot, context);
  validateResponseForSnapshot(snapshot, response);
  const ready = await commitReadyCredential(snapshot, response, context);
  assertActive(context);
  return readyResult(ready, true);
}

async function loadCredential(context) {
  try {
    return await context.credentialPort.load();
  } catch {
    throw flowError("credential_failure");
  }
}

async function createCredential(context) {
  let seed;
  try {
    const identity = context.generatePluginIdentity();
    seed = context.recordPort.createInitial({
      markId: identity.markId,
      markVersion: identity.markVersion,
      appSalt: identity.appSalt,
      machineId: identity.machineId,
      hostname: identity.hostname,
      platform: identity.platform,
      arch: identity.arch,
      macHash: identity.macHash,
    });
  } catch (error) {
    if (error instanceof TrialProvisionFlowError) throw error;
    throw flowError("identity_generation_failed");
  }
  try {
    const result = await context.credentialPort.createIfAbsent(seed);
    if (!isRecord(result) || !Object.hasOwn(result, "record")) {
      throw flowError("credential_failure");
    }
    return result.record;
  } catch (error) {
    if (error instanceof TrialProvisionFlowError) throw error;
    throw flowError("credential_failure");
  }
}

async function provisionWithRetry(snapshot, context) {
  let transientRetries = 0;
  let rateLimitRetries = 0;
  let uncertainSuccessRetries = 0;
  const request = Object.freeze({
    markId: snapshot.mark_id,
    markVersion: snapshot.mark_version,
    appSalt: snapshot.app_salt,
    machineId: snapshot.machine_id,
    hostname: snapshot.hostname,
    platform: snapshot.platform,
    arch: snapshot.arch,
    macHash: snapshot.mac_hash,
  });

  while (true) {
    consumeHttpRequest(context);
    try {
      const response = await context.client.provision(request, { signal: context.signal });
      assertActive(context);
      return response;
    } catch (error) {
      const clientError = safeClientError(error, context);
      if (isTransient(clientError) && transientRetries < MAX_TRANSIENT_RETRIES) {
        await waitForRetry(backoffDelay(transientRetries++, context), context);
        continue;
      }
      if (clientError.reason === "rate_limit_exceeded"
        && clientError.retryAfterMs !== undefined
        && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries += 1;
        await waitForRetry(clientError.retryAfterMs, context);
        continue;
      }
      if ((clientError.reason === "invalid_response"
          || clientError.reason === "response_contract")
        && clientError.httpStatus === 200
        && uncertainSuccessRetries < MAX_UNCERTAIN_SUCCESS_RETRIES) {
        uncertainSuccessRetries += 1;
        continue;
      }
      throw clientError;
    }
  }
}

function validateResponseForSnapshot(snapshot, response) {
  if (!isRecord(response)
    || typeof response.created !== "boolean"
    || typeof response.accountId !== "string"
    || typeof response.projectId !== "string"
    || typeof response.apiKey !== "string"
    || !API_KEY_PATTERN.test(response.apiKey)
    || snapshot.state !== "provisioning") {
    throw flowError("response_state_mismatch");
  }
}

async function commitReadyCredential(snapshot, response, context) {
  let conflict = false;
  let invalidResponse = false;
  try {
    return await context.credentialPort.transition((current) => {
      if (sameCredentialSnapshot(current, snapshot)) {
        try {
          return context.recordPort.complete(current, {
            accountId: response.accountId,
            projectId: response.projectId,
            apiKey: response.apiKey,
          });
        } catch {
          invalidResponse = true;
          throw new Error("invalid response");
        }
      }
      if (sameCompletedIdentity(current, snapshot, response)) return undefined;
      conflict = true;
      throw new Error("credential conflict");
    });
  } catch {
    if (conflict) throw flowError("credential_conflict");
    if (invalidResponse) throw flowError("response_state_mismatch");
    throw flowError("credential_failure");
  }
}

function sameCredentialSnapshot(current, snapshot) {
  return isRecord(current)
    && CREDENTIAL_FIELDS.every((field) => current[field] === snapshot[field]);
}

function sameCompletedIdentity(current, snapshot, response) {
  return isRecord(current)
    && current.state === "ready"
    && MARK_IDENTITY_FIELDS.every((field) => current[field] === snapshot[field])
    && current.api_key === response.apiKey
    && current.account_id === response.accountId
    && current.project_id === response.projectId;
}

function snapshotCredential(record) {
  return Object.freeze(Object.fromEntries(
    CREDENTIAL_FIELDS.map((field) => [field, record[field]]),
  ));
}

function assertCredentialRecord(record) {
  if (!isRecord(record)
    || (record.state !== "provisioning" && record.state !== "ready")
    || typeof record.mark_id !== "string"
    || !MARK_ID_PATTERN.test(record.mark_id)
    || (record.state === "provisioning" && record.api_key !== null)
    || (record.state === "ready"
      && (typeof record.api_key !== "string"
        || !API_KEY_PATTERN.test(record.api_key)
        || typeof record.account_id !== "string"
        || typeof record.project_id !== "string"))) {
    throw flowError("invalid_credential_state");
  }
}

function readyResult(record, provisioned) {
  assertCredentialRecord(record);
  if (record.state !== "ready") throw flowError("credential_failure");
  return Object.freeze({
    status: "ready",
    provisioned,
    markId: record.mark_id,
    accountId: record.account_id,
    projectId: record.project_id,
    apiKey: record.api_key,
  });
}

function createFlowDeadline(runtime) {
  const deadlineController = new AbortController();
  let deadlineExpired = false;
  const signal = combinedSignal(runtime.signal, deadlineController.signal);
  const deadlineAt = readNow(runtime.now) + runtime.totalTimeoutMs;
  const timer = setTimeout(() => {
    deadlineExpired = true;
    deadlineController.abort();
  }, runtime.totalTimeoutMs);
  timer.unref?.();
  return {
    context: {
      ...runtime,
      signal,
      callerSignal: runtime.signal,
      deadlineExpired: () => deadlineExpired,
      deadlineAt,
      httpRequests: 0,
    },
    timer,
  };
}

function consumeHttpRequest(context) {
  assertActive(context);
  if (context.httpRequests >= context.maxHttpRequests) {
    throw flowError("http_budget_exhausted");
  }
  context.httpRequests += 1;
}

function assertActive(context) {
  throwIfInterrupted(context);
}

function remainingTime(context) {
  return Math.max(0, context.deadlineAt - readNow(context.now));
}

async function waitForRetry(delayMs, context) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw flowError("retry_failed");
  assertActive(context);
  if (delayMs >= remainingTime(context)) throw flowError("deadline_exceeded");
  try {
    await context.sleep(delayMs, { signal: context.signal });
  } catch {
    throwIfInterrupted(context);
    throw flowError("retry_failed");
  }
  assertActive(context);
}

function backoffDelay(retryIndex, context) {
  let sample;
  try {
    sample = context.random();
  } catch {
    throw flowError("retry_failed");
  }
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw flowError("retry_failed");
  }
  return RETRY_DELAYS_MS[retryIndex] + Math.floor(sample * (MAX_JITTER_MS + 1));
}

function isTransient(error) {
  return error.reason === "transport"
    || error.reason === "timeout"
    || error.reason === "server_error";
}

function safeClientError(error, context) {
  throwIfInterrupted(context);
  if (error instanceof TrialProvisionClientError) return error;
  throw flowError("client_failure");
}

function throwIfInterrupted(context) {
  if (context.deadlineExpired?.() || remainingTime(context) <= 0) {
    throw flowError("deadline_exceeded");
  }
  if (context.callerSignal?.aborted || context.signal?.aborted) {
    throw flowError("aborted");
  }
}

function validateOptions(options) {
  const credentialPort = options?.credentialPort;
  const recordPort = options?.recordPort;
  const client = options?.client;
  if (!hasFunctions(credentialPort, [
    "load",
    "createIfAbsent",
    "transition",
    "withProvisionLock",
  ])
    || !hasFunctions(recordPort, ["createInitial", "complete"])
    || !hasFunctions(client, ["provision"])) {
    throw flowError("invalid_options");
  }
  const generatePluginIdentity = options?.generatePluginIdentity ?? generateTrialPluginIdentity;
  const random = options?.random ?? Math.random;
  const sleep = options?.sleep ?? abortableSleep;
  const now = options?.now ?? Date.now;
  if (![generatePluginIdentity, random, sleep, now]
    .every((value) => typeof value === "function")) {
    throw flowError("invalid_options");
  }
  const totalTimeoutMs = boundedPositiveInteger(
    options?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    600_000,
  );
  const maxHttpRequests = boundedPositiveInteger(
    options?.maxHttpRequests ?? DEFAULT_MAX_HTTP_REQUESTS,
    16,
  );
  readNow(now);
  return {
    credentialPort,
    recordPort,
    client,
    generatePluginIdentity,
    random,
    sleep,
    now,
    totalTimeoutMs,
    maxHttpRequests,
    signal: options?.signal,
  };
}

function boundedPositiveInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw flowError("invalid_options");
  }
  return value;
}

function readNow(now) {
  try {
    const value = now();
    if (!Number.isFinite(value)) throw new Error("invalid clock");
    return value;
  } catch {
    throw flowError("invalid_options");
  }
}

function combinedSignal(first, second) {
  if (!first) return second;
  try {
    return AbortSignal.any([first, second]);
  } catch {
    throw flowError("invalid_options");
  }
}

async function abortableSleep(delayMs, options = {}) {
  if (options.signal?.aborted) throw flowError("aborted");
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(), delayMs);
    const onAbort = () => finish(flowError("aborted"));
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function hasFunctions(value, names) {
  return isRecord(value) && names.every((name) => typeof value[name] === "function");
}

function flowError(reason) {
  return new TrialProvisionFlowError(reason);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  TrialProvisionClientError,
} from "./trial-provision-client.mjs";
import { generateTrialPluginIdentity } from "./trial-plugin-mark.mjs";
import {
  solveTrialPow,
  TrialPowError,
} from "./trial-pow.mjs";

export {
  generateTrialPluginIdentity,
  generateTrialPluginMark,
} from "./trial-plugin-mark.mjs";

const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_POW_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HTTP_REQUESTS = 8;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_POW_EXPIRED_REFRESHES = 2;
const MAX_UNCERTAIN_SUCCESS_RETRIES = 1;
const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);
const MAX_JITTER_MS = 250;
const MARK_IDENTITY_FIELDS = Object.freeze([
  "plugin_mark",
  "app_salt",
  "machine_id_hash",
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
  "warn_remaining_threshold",
  "warn_remaining_step",
  "register_url",
  "last_warned_level",
]);
const PLUGIN_MARK_PATTERN = /^mk_[0-9a-f]{32}$/;
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
  "pow_failed",
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

export function generateTrialApiKey(randomBytes = nodeRandomBytes) {
  return `sk_${secureRandomBytes(randomBytes, 32).toString("base64url")}`;
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
      || error instanceof TrialProvisionClientError
      || error instanceof TrialPowError) {
      throw error;
    }
    throw flowError("credential_failure");
  } finally {
    clearTimeout(deadline.timer);
  }
}

function createFlowDeadline(runtime) {
  const deadlineController = new AbortController();
  let deadlineExpired = false;
  const signal = combinedSignal(runtime.signal, deadlineController.signal);
  const deadlineAt = readNow(runtime.now) + runtime.totalTimeoutMs;
  const deadlineTimer = setTimeout(
    () => {
      deadlineExpired = true;
      deadlineController.abort();
    },
    runtime.totalTimeoutMs,
  );
  return {
    context: {
      ...runtime,
      signal,
      callerSignal: runtime.signal,
      deadlineExpired: () => deadlineExpired,
      deadlineAt,
      httpRequests: 0,
    },
    timer: deadlineTimer,
  };
}

async function runTrialCredentialFlow(context) {
  let record = await loadCredential(context);
  if (record === null) record = await createCredential(context);
  assertActive(context);
  assertCredentialRecord(record);
  if (record.state === "ready") return readyResult(record, false);

  const snapshot = snapshotCredential(record);
  let powExpiredRefreshes = 0;
  let currentChallenge = await requestChallengeWithRetry(snapshot.plugin_mark, context);

  while (true) {
    assertActive(context);
    const powNonce = await solveChallenge(currentChallenge, context);
    let response;
    try {
      response = await provisionWithRetry(snapshot, currentChallenge, powNonce, context);
    } catch (error) {
      if (!(error instanceof TrialProvisionClientError)
        || error.reason !== "pow_expired"
        || powExpiredRefreshes >= MAX_POW_EXPIRED_REFRESHES) {
        throw error;
      }
      powExpiredRefreshes += 1;
      currentChallenge = await requestChallengeWithRetry(snapshot.plugin_mark, context);
      continue;
    }

    validateResponseForSnapshot(snapshot, response);
    const ready = await commitReadyCredential(snapshot, response, context);
    assertActive(context);
    return readyResult(ready, true);
  }
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
      pluginMark: identity.pluginMark,
      appSalt: identity.appSalt,
      machineIdHash: identity.machineIdHash,
      hostname: identity.hostname,
      platform: identity.platform,
      arch: identity.arch,
      macHash: identity.macHash,
      apiKey: generateTrialApiKey(context.randomBytes),
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

async function requestChallengeWithRetry(pluginMark, context) {
  let transientRetries = 0;
  let rateLimitRetries = 0;
  while (true) {
    consumeHttpRequest(context);
    try {
      const challenge = await context.client.requestPowChallenge(pluginMark, {
        signal: context.signal,
      });
      assertActive(context);
      return challenge;
    } catch (error) {
      const clientError = safeClientError(error, context);
      if (isTransient(clientError) && transientRetries < MAX_TRANSIENT_RETRIES) {
        await waitForRetry(backoffDelay(transientRetries++, context), context);
        continue;
      }
      if (clientError.reason === "rate_limit_exceeded"
        && clientError.retryAfterMs !== undefined
        && clientError.retryAfterExceeded !== true
        && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries += 1;
        await waitForRetry(clientError.retryAfterMs, context);
        continue;
      }
      throw clientError;
    }
  }
}

async function solveChallenge(challenge, context) {
  const remaining = remainingTime(context);
  if (remaining <= 0) throw flowError("deadline_exceeded");
  try {
    return await context.solvePow(
      challenge?.powChallenge,
      challenge?.difficultyBits,
      {
        signal: context.signal,
        timeoutMs: Math.min(context.powTimeoutMs, remaining),
      },
    );
  } catch (error) {
    throwIfInterrupted(context);
    if (error instanceof TrialPowError) throw error;
    throw flowError("pow_failed");
  }
}

async function provisionWithRetry(snapshot, challenge, powNonce, context) {
  let transientRetries = 0;
  let rateLimitRetries = 0;
  let uncertainSuccessRetries = 0;
  const request = Object.freeze({
    pluginMark: snapshot.plugin_mark,
    appSalt: snapshot.app_salt,
    machineIdHash: snapshot.machine_id_hash,
    hostname: snapshot.hostname,
    platform: snapshot.platform,
    arch: snapshot.arch,
    macHash: snapshot.mac_hash,
    apiKey: snapshot.api_key,
    powChallenge: challenge?.powChallenge,
    powNonce,
    recoverApiKey: snapshot.state === "recovering",
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
        && clientError.retryAfterExceeded !== true
        && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries += 1;
        await waitForRetry(clientError.retryAfterMs, context);
        continue;
      }
      if (clientError.reason === "invalid_response"
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
    || typeof response.apiKeyRecovered !== "boolean"
    || typeof response.accountId !== "string"
    || typeof response.projectId !== "string") {
    throw flowError("response_state_mismatch");
  }
  if ((snapshot.state === "provisioning" && response.apiKeyRecovered)
    || (snapshot.state === "recovering" && response.created)
    || (response.created && response.apiKeyRecovered)) {
    throw flowError("response_state_mismatch");
  }
  if ((snapshot.account_id !== null && snapshot.account_id !== response.accountId)
    || (snapshot.project_id !== null && snapshot.project_id !== response.projectId)) {
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
            warnRemainingThreshold: response.warnRemainingThreshold,
            warnRemainingStep: response.warnRemainingStep,
            registerUrl: response.registerUrl,
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
    && current.api_key === snapshot.api_key
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
    || (record.state !== "provisioning"
      && record.state !== "recovering"
      && record.state !== "ready")
    || typeof record.plugin_mark !== "string"
    || !PLUGIN_MARK_PATTERN.test(record.plugin_mark)
    || typeof record.api_key !== "string"
    || !API_KEY_PATTERN.test(record.api_key)) {
    throw flowError("invalid_credential_state");
  }
  if (record.state === "ready"
    && (typeof record.account_id !== "string"
      || typeof record.project_id !== "string")) {
    throw flowError("invalid_credential_state");
  }
}

function readyResult(record, provisioned) {
  assertCredentialRecord(record);
  if (record.state !== "ready") throw flowError("credential_failure");
  return Object.freeze({
    status: "ready",
    provisioned,
    pluginMark: record.plugin_mark,
    accountId: record.account_id,
    projectId: record.project_id,
    registerUrl: record.register_url,
  });
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
    || error.reason === "server_error"
    || error.reason === "trial_capacity_unavailable";
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
    || !hasFunctions(client, ["requestPowChallenge", "provision"])) {
    throw flowError("invalid_options");
  }
  const solvePow = options?.solvePow ?? solveTrialPow;
  const generatePluginIdentity = options?.generatePluginIdentity ?? generateTrialPluginIdentity;
  const randomBytes = options?.randomBytes ?? nodeRandomBytes;
  const random = options?.random ?? Math.random;
  const sleep = options?.sleep ?? abortableSleep;
  const now = options?.now ?? Date.now;
  if (![solvePow, generatePluginIdentity, randomBytes, random, sleep, now]
    .every((value) => typeof value === "function")) {
    throw flowError("invalid_options");
  }
  const totalTimeoutMs = boundedPositiveInteger(
    options?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    600_000,
  );
  const powTimeoutMs = boundedPositiveInteger(
    options?.powTimeoutMs ?? Math.min(DEFAULT_POW_TIMEOUT_MS, totalTimeoutMs),
    totalTimeoutMs,
  );
  const maxHttpRequests = boundedPositiveInteger(
    options?.maxHttpRequests ?? DEFAULT_MAX_HTTP_REQUESTS,
    32,
  );
  readNow(now);
  return {
    credentialPort,
    recordPort,
    client,
    solvePow,
    generatePluginIdentity,
    randomBytes,
    random,
    sleep,
    now,
    totalTimeoutMs,
    powTimeoutMs,
    maxHttpRequests,
    signal: options?.signal,
  };
}

function secureRandomBytes(randomBytes, size) {
  try {
    const value = randomBytes(size);
    if (!(value instanceof Uint8Array) || value.byteLength !== size) {
      throw new Error("invalid random bytes");
    }
    return Buffer.from(value);
  } catch {
    throw flowError("identity_generation_failed");
  }
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
    const onAbort = () => {
      finish(flowError("aborted"));
    };
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

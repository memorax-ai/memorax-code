import {
  TrialProvisionClientError,
  trialSystemCode,
} from "./trial-provision-client.mjs";
import { generateTrialPluginIdentity } from "./trial-plugin-mark.mjs";

export {
  generateTrialPluginIdentity,
  generateTrialMarkId,
} from "./trial-plugin-mark.mjs";

const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);
const ERROR_REASONS = new Set([
  "invalid_options",
  "invalid_credential_state",
  "identity_generation_failed",
  "credential_failure",
  "response_state_mismatch",
  "client_failure",
  "retry_failed",
]);
const STAGES = new Set([
  "credential_lock", "credential_load", "identity", "credential_create",
  "provision", "credential_complete", "retry",
]);
const CREDENTIAL_REASONS = {
  TRIAL_CREDENTIAL_BACKEND_ERROR: new Set([
    "backend_unavailable", "command_failed", "command_timeout", "invalid_namespace",
    "invalid_response", "invalid_secret", "output_limit", "secret_too_large",
    "storage_failed", "unsafe_path",
  ]),
  TRIAL_CREDENTIAL_RECORD_INVALID: new Set([
    "malformed_json", "invalid_record", "unknown_fields", "missing_fields",
    "unsupported_version", "invalid_version", "invalid_state", "invalid_mark_id",
    "invalid_mark_version", "invalid_app_salt", "invalid_machine_id", "invalid_hostname",
    "invalid_platform", "invalid_arch", "invalid_mac_hash", "invalid_api_key",
    "invalid_shape", "invalid_account_id", "invalid_project_id", "invalid_transition",
  ]),
};
const CREDENTIAL_LOCK_CODES = new Set([
  "JSON_FILE_LOCK_TIMEOUT", "JSON_FILE_LOCK_RELEASE_FAILED",
]);
const MARK_ID_PATTERN = /^mk_[0-9a-f]{64}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;

export class TrialProvisionFlowError extends Error {
  constructor(reason, fields = {}) {
    const safeReason = ERROR_REASONS.has(reason) ? reason : "client_failure";
    super(`Trial provision flow failed (${safeReason})`);
    this.name = "TrialProvisionFlowError";
    this.code = "TRIAL_PROVISION_FLOW_FAILED";
    this.reason = safeReason;
    this.stage = STAGES.has(fields.stage) ? fields.stage : "unknown";
    const error = fields.error;
    const code = error?.errorCode ?? error?.code;
    this.errorCode = Object.hasOwn(CREDENTIAL_REASONS, code) || CREDENTIAL_LOCK_CODES.has(code)
      ? code
      : this.code;
    const credentialReason = error?.credentialReason ?? error?.reason;
    if (CREDENTIAL_REASONS[this.errorCode]?.has(credentialReason)) {
      this.credentialReason = credentialReason;
    }
    const systemCode = trialSystemCode({ code: error?.systemCode }) ?? trialSystemCode(error);
    if (systemCode) this.systemCode = systemCode;
  }
}

export async function ensureTrialCredentialReady(options = {}) {
  const context = validateOptions(options);
  context.stage = "credential_lock";
  try {
    // Serialize the remote request through local completion so another setup
    // cannot provision while the returned credential is still uncommitted.
    return await context.credentialPort.withProvisionLock(
      async () => {
        const result = await runTrialCredentialFlow(context);
        context.stage = "credential_lock";
        return result;
      },
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    let failure = error;
    let releaseError;
    // config-utils retains the operation failure as cause when lock release
    // also fails. Keep that operation's classification and report cleanup apart.
    if (error instanceof AggregateError && error.code === "JSON_FILE_LOCK_RELEASE_FAILED"
      && error.errors.length === 2 && error.cause === error.errors[0]
      && error.errors[1]?.code === "JSON_FILE_LOCK_RELEASE_FAILED") {
      [failure, releaseError] = error.errors;
    }
    const stage = CREDENTIAL_LOCK_CODES.has(failure?.code) ? "credential_lock" : context.stage;
    if (failure instanceof TrialProvisionFlowError) {
      if (failure.stage === "unknown") failure.stage = stage;
    } else if (!(failure instanceof TrialProvisionClientError)) {
      failure = flowError("credential_failure", stage, failure);
    }
    if (releaseError) {
      failure.cleanupErrorCode = "JSON_FILE_LOCK_RELEASE_FAILED";
      const systemCode = trialSystemCode(releaseError);
      if (systemCode) failure.cleanupSystemCode = systemCode;
    }
    throw failure;
  }
}

async function runTrialCredentialFlow(context) {
  context.stage = "credential_load";
  let record = await context.credentialPort.load();
  // Persist the identity before the request and retain it on failure so a later
  // attempt can replay the same provisioning identity.
  if (record === null) record = await createCredential(context);
  assertCredentialRecord(record);
  if (record.state === "ready") return readyResult(record, false);

  context.stage = "provision";
  const response = await provisionWithRetry(record, context);
  validateProvisionResponse(response);
  context.stage = "credential_complete";
  const ready = await context.credentialPort.complete(record, {
    accountId: response.accountId,
    projectId: response.projectId,
    apiKey: response.apiKey,
  });
  return readyResult(ready, true);
}

async function createCredential(context) {
  context.stage = "identity";
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
    throw flowError("identity_generation_failed", context.stage, error);
  }
  context.stage = "credential_create";
  const result = await context.credentialPort.createIfAbsent(seed);
  if (!isRecord(result) || !Object.hasOwn(result, "record")) {
    throw flowError("credential_failure");
  }
  return result.record;
}

async function provisionWithRetry(record, context) {
  const request = Object.freeze({
    markId: record.mark_id,
    markVersion: record.mark_version,
    appSalt: record.app_salt,
    machineId: record.machine_id,
    hostname: record.hostname,
    platform: record.platform,
    arch: record.arch,
    macHash: record.mac_hash,
  });

  for (let attempt = 0; ; attempt += 1) {
    context.stage = "provision";
    try {
      return await context.client.provision(request);
    } catch (error) {
      if (!(error instanceof TrialProvisionClientError)) {
        throw flowError("client_failure", context.stage, error);
      }
      const delay = retryDelay(error, attempt);
      if (delay === undefined) throw error;
      context.stage = "retry";
      try {
        await context.sleep(delay);
      } catch (error) {
        throw flowError("retry_failed", context.stage, error);
      }
    }
  }
}

function retryDelay(error, attempt) {
  if (attempt >= RETRY_DELAYS_MS.length) return undefined;
  if (error.reason === "rate_limit_exceeded") return error.retryAfterMs;
  if (["transport", "timeout", "server_error"].includes(error.reason)) {
    return RETRY_DELAYS_MS[attempt];
  }
  if (["invalid_response", "response_contract"].includes(error.reason)
    && error.httpStatus === 200
    && attempt === 0) {
    return 0;
  }
  return undefined;
}

function validateProvisionResponse(response) {
  if (!isRecord(response)
    || typeof response.accountId !== "string"
    || typeof response.projectId !== "string"
    || typeof response.apiKey !== "string"
    || !API_KEY_PATTERN.test(response.apiKey)
    || typeof response.created !== "boolean") {
    throw flowError("response_state_mismatch");
  }
}

function assertCredentialRecord(record) {
  if (!isRecord(record)
    || !["provisioning", "ready"].includes(record.state)
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

function validateOptions(options) {
  const credentialPort = options.credentialPort;
  const recordPort = options.recordPort;
  const client = options.client;
  if (!hasFunctions(credentialPort, [
    "load",
    "createIfAbsent",
    "complete",
    "withProvisionLock",
  ])
    || !hasFunctions(recordPort, ["createInitial"])
    || !hasFunctions(client, ["provision"])) {
    throw flowError("invalid_options");
  }
  const generatePluginIdentity = options.generatePluginIdentity ?? generateTrialPluginIdentity;
  const sleep = options.sleep ?? defaultSleep;
  if (typeof generatePluginIdentity !== "function" || typeof sleep !== "function") {
    throw flowError("invalid_options");
  }
  return {
    credentialPort,
    recordPort,
    client,
    generatePluginIdentity,
    sleep,
  };
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function hasFunctions(value, names) {
  return isRecord(value) && names.every((name) => typeof value[name] === "function");
}

export function trialProvisionFailureDetails(error) {
  if (error instanceof TrialProvisionClientError) {
    const safe = new TrialProvisionClientError(error.reason, error);
    return {
      errorCode: safe.code,
      stage: "provision",
      failureReason: safe.reason,
      ...(safe.systemCode ? { systemCode: safe.systemCode } : {}),
      ...(safe.httpStatus === undefined ? {} : { httpStatus: safe.httpStatus }),
      ...(safe.retryAfterMs === undefined ? {} : { retryAfterMs: safe.retryAfterMs }),
      ...cleanupFailureDetails(error),
    };
  }
  if (error instanceof TrialProvisionFlowError) {
    const safe = new TrialProvisionFlowError(error.reason, { stage: error.stage, error });
    return {
      errorCode: safe.errorCode,
      stage: safe.stage,
      failureReason: safe.reason,
      ...(safe.credentialReason ? { credentialReason: safe.credentialReason } : {}),
      ...(safe.systemCode ? { systemCode: safe.systemCode } : {}),
      ...cleanupFailureDetails(error),
    };
  }
  return { errorCode: "TRIAL_SETUP_FAILED", stage: "unknown" };
}

function cleanupFailureDetails(error) {
  if (error.cleanupErrorCode !== "JSON_FILE_LOCK_RELEASE_FAILED") return {};
  const systemCode = trialSystemCode({ code: error.cleanupSystemCode });
  return {
    cleanupErrorCode: "JSON_FILE_LOCK_RELEASE_FAILED",
    ...(systemCode ? { cleanupSystemCode: systemCode } : {}),
  };
}

function flowError(reason, stage, error) {
  return new TrialProvisionFlowError(reason, { stage, error });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  TrialProvisionClientError,
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
const MARK_ID_PATTERN = /^mk_[0-9a-f]{64}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;

export class TrialProvisionFlowError extends Error {
  constructor(reason) {
    const safeReason = ERROR_REASONS.has(reason) ? reason : "client_failure";
    super(`Trial provision flow failed (${safeReason})`);
    this.name = "TrialProvisionFlowError";
    this.code = "TRIAL_PROVISION_FLOW_FAILED";
    this.reason = safeReason;
  }
}

export async function ensureTrialCredentialReady(options = {}) {
  const context = validateOptions(options);
  try {
    return await context.credentialPort.withProvisionLock(
      () => runTrialCredentialFlow(context),
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    if (error instanceof TrialProvisionFlowError
      || error instanceof TrialProvisionClientError) {
      throw error;
    }
    throw flowError("credential_failure");
  }
}

async function runTrialCredentialFlow(context) {
  let record = await context.credentialPort.load();
  if (record === null) record = await createCredential(context);
  assertCredentialRecord(record);
  if (record.state === "ready") return readyResult(record, false);

  const response = await provisionWithRetry(record, context);
  validateProvisionResponse(response);
  const ready = await context.credentialPort.complete(record, {
    accountId: response.accountId,
    projectId: response.projectId,
    apiKey: response.apiKey,
  });
  return readyResult(ready, true);
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
  } catch {
    throw flowError("identity_generation_failed");
  }
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
    try {
      return await context.client.provision(request);
    } catch (error) {
      if (!(error instanceof TrialProvisionClientError)) {
        throw flowError("client_failure");
      }
      const delay = retryDelay(error, attempt);
      if (delay === undefined) throw error;
      try {
        await context.sleep(delay);
      } catch {
        throw flowError("retry_failed");
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

function flowError(reason) {
  return new TrialProvisionFlowError(reason);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

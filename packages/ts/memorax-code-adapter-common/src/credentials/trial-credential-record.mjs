export const TRIAL_CREDENTIAL_RECORD_VERSION = 1;

const RECORD_KEYS = Object.freeze([
  "version",
  "state",
  "mark_id",
  "mark_version",
  "app_salt",
  "machine_id",
  "hostname",
  "platform",
  "arch",
  "mac_hash",
  "api_key",
  "account_id",
  "project_id",
]);
const RECORD_KEY_SET = new Set(RECORD_KEYS);
const MARK_ID_PATTERN = /^mk_[0-9a-f]{64}$/;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;
const DECIMAL_PUBLIC_ID_PATTERN = /^[0-9]+$/;
const ERROR_REASONS = new Set([
  "malformed_json",
  "invalid_record",
  "unknown_fields",
  "missing_fields",
  "unsupported_version",
  "invalid_version",
  "invalid_state",
  "invalid_mark_id",
  "invalid_mark_version",
  "invalid_app_salt",
  "invalid_machine_id",
  "invalid_hostname",
  "invalid_platform",
  "invalid_arch",
  "invalid_mac_hash",
  "invalid_api_key",
  "invalid_shape",
  "invalid_account_id",
  "invalid_project_id",
  "invalid_transition",
]);

export class TrialCredentialRecordError extends Error {
  constructor(reason) {
    const safeReason = ERROR_REASONS.has(reason) ? reason : "invalid_record";
    super(`Trial credential record is invalid (${safeReason})`);
    this.name = "TrialCredentialRecordError";
    this.code = "TRIAL_CREDENTIAL_RECORD_INVALID";
    this.reason = safeReason;
  }
}

export function parseTrialCredentialRecord(text) {
  if (typeof text !== "string") {
    throw new TypeError("Trial credential record input must be a string");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("malformed_json");
  }
  return validateRecord(value);
}

export function validateTrialCredentialRecord(value) {
  return validateRecord(value);
}

export function serializeTrialCredentialRecord(value) {
  const record = validateTrialCredentialRecord(value);
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function createInitialTrialCredentialRecord(options) {
  return validateRecord({
    version: TRIAL_CREDENTIAL_RECORD_VERSION,
    state: "provisioning",
    mark_id: options?.markId,
    mark_version: options?.markVersion,
    app_salt: options?.appSalt,
    machine_id: options?.machineId,
    hostname: options?.hostname,
    platform: options?.platform,
    arch: options?.arch,
    mac_hash: options?.macHash,
    api_key: null,
    account_id: null,
    project_id: null,
  });
}

export function completeTrialCredentialProvisioning(value, metadata) {
  const record = validateRecord(value);
  if (record.state !== "provisioning") fail("invalid_transition");
  return validateRecord({
    ...record,
    state: "ready",
    api_key: metadata?.apiKey,
    account_id: metadata?.accountId,
    project_id: metadata?.projectId,
  });
}

function validateRecord(value) {
  if (!isRecord(value)) fail("invalid_record");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !RECORD_KEY_SET.has(key))) {
    fail("unknown_fields");
  }
  if (RECORD_KEYS.some((key) => !Object.hasOwn(value, key))) fail("missing_fields");
  const snapshot = Object.fromEntries(RECORD_KEYS.map((key) => [key, value[key]]));

  if (snapshot.version !== TRIAL_CREDENTIAL_RECORD_VERSION) {
    if (Number.isSafeInteger(snapshot.version) && snapshot.version > 0) {
      fail("unsupported_version");
    }
    fail("invalid_version");
  }
  if (snapshot.state !== "provisioning" && snapshot.state !== "ready") {
    fail("invalid_state");
  }
  if (typeof snapshot.mark_id !== "string" || !MARK_ID_PATTERN.test(snapshot.mark_id)) {
    fail("invalid_mark_id");
  }
  if (snapshot.mark_version !== 1) fail("invalid_mark_version");
  if (snapshot.app_salt !== "memorax-plugin-v1") fail("invalid_app_salt");
  if (typeof snapshot.machine_id !== "string"
    || !MACHINE_ID_PATTERN.test(snapshot.machine_id)) {
    fail("invalid_machine_id");
  }
  if (!validBoundedText(snapshot.hostname, 120)) fail("invalid_hostname");
  if (!["windows", "linux", "macos"].includes(snapshot.platform)) {
    fail("invalid_platform");
  }
  if (!["x86_64", "arm64"].includes(snapshot.arch)) fail("invalid_arch");
  if (typeof snapshot.mac_hash !== "string"
    || !SHA256_HEX_PATTERN.test(snapshot.mac_hash)) {
    fail("invalid_mac_hash");
  }

  if (snapshot.state === "provisioning") {
    if (snapshot.api_key !== null
      || snapshot.account_id !== null
      || snapshot.project_id !== null) {
      fail("invalid_shape");
    }
    return Object.freeze(snapshot);
  }

  if (typeof snapshot.api_key !== "string" || !API_KEY_PATTERN.test(snapshot.api_key)) {
    fail("invalid_api_key");
  }
  if (!decimalPublicId(snapshot.account_id)) fail("invalid_account_id");
  if (!decimalPublicId(snapshot.project_id)) fail("invalid_project_id");
  return Object.freeze(snapshot);
}

function decimalPublicId(value) {
  return typeof value === "string" && DECIMAL_PUBLIC_ID_PATTERN.test(value);
}

function validBoundedText(value, maximumLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim()
    && !value.includes("\0");
}

function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(reason) {
  throw new TrialCredentialRecordError(reason);
}

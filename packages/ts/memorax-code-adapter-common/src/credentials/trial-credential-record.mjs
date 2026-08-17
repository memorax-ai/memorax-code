export const TRIAL_CREDENTIAL_RECORD_VERSION = 1;

const RECORD_KEYS = Object.freeze([
  "version",
  "state",
  "plugin_mark",
  "app_salt",
  "machine_id_hash",
  "hostname",
  "platform",
  "arch",
  "mac_hash",
  "api_key",
  "account_id",
  "project_id",
  "warn_remaining_threshold",
  "warn_remaining_step",
  "register_url",
  "last_warned_level",
]);
const RECORD_KEY_SET = new Set(RECORD_KEYS);
const PLUGIN_MARK_PATTERN = /^mk_[0-9a-f]{32}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;
const API_KEY_IN_TEXT_PATTERN = /sk_[A-Za-z0-9_-]{43}/;
const DECIMAL_PUBLIC_ID_PATTERN = /^[0-9]+$/;
const MAX_APP_SALT_LENGTH = 256;
const MAX_HOSTNAME_LENGTH = 255;
const MAX_PLATFORM_LENGTH = 32;
const MAX_ARCH_LENGTH = 32;
const MAX_REGISTER_URL_DECODE_PASSES = 8;
const ERROR_REASONS = new Set([
  "malformed_json",
  "invalid_record",
  "unknown_fields",
  "missing_fields",
  "unsupported_version",
  "invalid_version",
  "invalid_state",
  "invalid_plugin_mark",
  "invalid_app_salt",
  "invalid_machine_id_hash",
  "invalid_hostname",
  "invalid_platform",
  "invalid_arch",
  "invalid_mac_hash",
  "invalid_api_key",
  "invalid_shape",
  "invalid_account_id",
  "invalid_project_id",
  "invalid_warn_remaining_threshold",
  "invalid_warn_remaining_step",
  "invalid_register_url",
  "invalid_last_warned_level",
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
    plugin_mark: options?.pluginMark,
    app_salt: options?.appSalt,
    machine_id_hash: options?.machineIdHash,
    hostname: options?.hostname,
    platform: options?.platform,
    arch: options?.arch,
    mac_hash: options?.macHash,
    api_key: options?.apiKey,
    account_id: null,
    project_id: null,
    warn_remaining_threshold: null,
    warn_remaining_step: null,
    register_url: null,
    last_warned_level: null,
  });
}

export function createTrialCredentialRecoveryRecord(options) {
  return validateRecord({
    version: TRIAL_CREDENTIAL_RECORD_VERSION,
    state: "recovering",
    plugin_mark: options?.pluginMark,
    app_salt: options?.appSalt,
    machine_id_hash: options?.machineIdHash,
    hostname: options?.hostname,
    platform: options?.platform,
    arch: options?.arch,
    mac_hash: options?.macHash,
    api_key: options?.apiKey,
    account_id: null,
    project_id: null,
    warn_remaining_threshold: null,
    warn_remaining_step: null,
    register_url: null,
    last_warned_level: null,
  });
}

export function beginTrialCredentialRecovery(value, options) {
  const record = validateRecord(value);
  if (record.state !== "ready") fail("invalid_transition");
  const apiKey = options?.apiKey;
  if (apiKey === record.api_key) fail("invalid_transition");
  return validateRecord({
    ...record,
    state: "recovering",
    api_key: apiKey,
  });
}

export function completeTrialCredentialProvisioning(value, metadata) {
  const record = validateRecord(value);
  if (record.state !== "provisioning" && record.state !== "recovering") {
    fail("invalid_transition");
  }
  const metadataRecord = isRecord(metadata);
  const accountId = metadata?.accountId;
  const projectId = metadata?.projectId;
  const warnRemainingThreshold = metadata?.warnRemainingThreshold;
  const warnRemainingStep = metadata?.warnRemainingStep;
  const registerUrl = metadata?.registerUrl;
  const hasLastWarnedLevel = metadataRecord
    && Object.hasOwn(metadata, "lastWarnedLevel");
  const suppliedLastWarnedLevel = hasLastWarnedLevel
    ? metadata.lastWarnedLevel
    : undefined;
  if (record.account_id !== null
    && (accountId !== record.account_id
      || projectId !== record.project_id)) {
    fail("invalid_transition");
  }
  const warningPolicyChanged = record.warn_remaining_threshold !== null
    && (warnRemainingThreshold !== record.warn_remaining_threshold
      || warnRemainingStep !== record.warn_remaining_step);
  return validateRecord({
    ...record,
    state: "ready",
    account_id: accountId,
    project_id: projectId,
    warn_remaining_threshold: warnRemainingThreshold,
    warn_remaining_step: warnRemainingStep,
    register_url: registerUrl,
    last_warned_level: warningPolicyChanged
      ? null
      : hasLastWarnedLevel
        ? suppliedLastWarnedLevel
        : record.last_warned_level,
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
  if (snapshot.state !== "provisioning"
    && snapshot.state !== "recovering"
    && snapshot.state !== "ready") {
    fail("invalid_state");
  }
  if (typeof snapshot.plugin_mark !== "string"
    || !PLUGIN_MARK_PATTERN.test(snapshot.plugin_mark)) {
    fail("invalid_plugin_mark");
  }
  if (!validBoundedText(snapshot.app_salt, MAX_APP_SALT_LENGTH, false)) {
    fail("invalid_app_salt");
  }
  if (typeof snapshot.machine_id_hash !== "string"
    || !SHA256_HEX_PATTERN.test(snapshot.machine_id_hash)) {
    fail("invalid_machine_id_hash");
  }
  if (!validBoundedText(snapshot.hostname, MAX_HOSTNAME_LENGTH, true)) {
    fail("invalid_hostname");
  }
  if (!validBoundedText(snapshot.platform, MAX_PLATFORM_LENGTH, false)) {
    fail("invalid_platform");
  }
  if (!validBoundedText(snapshot.arch, MAX_ARCH_LENGTH, false)) {
    fail("invalid_arch");
  }
  if (typeof snapshot.mac_hash !== "string"
    || (snapshot.mac_hash !== "" && !SHA256_HEX_PATTERN.test(snapshot.mac_hash))) {
    fail("invalid_mac_hash");
  }
  if (typeof snapshot.api_key !== "string" || !API_KEY_PATTERN.test(snapshot.api_key)) {
    fail("invalid_api_key");
  }

  const serverFields = [
    snapshot.account_id,
    snapshot.project_id,
    snapshot.warn_remaining_threshold,
    snapshot.warn_remaining_step,
    snapshot.register_url,
    snapshot.last_warned_level,
  ];
  if (serverFields.every((field) => field === null)) {
    if (snapshot.state === "ready") fail("invalid_shape");
    return Object.freeze(snapshot);
  }

  if (snapshot.state === "provisioning") fail("invalid_shape");

  if (!decimalPublicId(snapshot.account_id)) fail("invalid_account_id");
  if (!decimalPublicId(snapshot.project_id)) fail("invalid_project_id");
  if (!nonNegativeSafeInteger(snapshot.warn_remaining_threshold)) {
    fail("invalid_warn_remaining_threshold");
  }
  if (!positiveSafeInteger(snapshot.warn_remaining_step)) {
    fail("invalid_warn_remaining_step");
  }
  if (snapshot.warn_remaining_threshold !== 0
    && (snapshot.warn_remaining_threshold < snapshot.warn_remaining_step
      || snapshot.warn_remaining_threshold % snapshot.warn_remaining_step !== 0)) {
    fail("invalid_warn_remaining_threshold");
  }
  if (!validRegisterUrl(snapshot.register_url)) fail("invalid_register_url");
  if (!validLastWarnedLevel(
    snapshot.last_warned_level,
    snapshot.warn_remaining_threshold,
    snapshot.warn_remaining_step,
  )) {
    fail("invalid_last_warned_level");
  }
  return Object.freeze(snapshot);
}

function validRegisterUrl(value) {
  if (typeof value !== "string"
    || !value
    || value !== value.trim()
    || containsApiKey(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !containsApiKey(url.href);
  } catch {
    return false;
  }
}

function containsApiKey(value) {
  let candidate = value;
  for (let index = 0; index <= MAX_REGISTER_URL_DECODE_PASSES; index += 1) {
    if (API_KEY_IN_TEXT_PATTERN.test(candidate)) return true;
    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded === candidate) return false;
    if (index === MAX_REGISTER_URL_DECODE_PASSES) return true;
    candidate = decoded;
  }
  return true;
}

function validLastWarnedLevel(value, threshold, step) {
  if (value === null) return true;
  return positiveSafeInteger(value)
    && value <= threshold
    && (threshold - value) % step === 0;
}

function decimalPublicId(value) {
  return typeof value === "string" && DECIMAL_PUBLIC_ID_PATTERN.test(value);
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validBoundedText(value, maximumLength, allowEmpty) {
  return typeof value === "string"
    && value.length <= maximumLength
    && (allowEmpty || value.length > 0)
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

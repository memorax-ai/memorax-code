const DECIMAL_PUBLIC_ID_PATTERN = /^[0-9]+$/;
const PLUGIN_MARK_PATTERN = /^mk_[0-9a-f]{32}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;
const API_KEY_IN_TEXT_PATTERN = /sk_[A-Za-z0-9_-]{43}/;
const MAX_REGISTER_URL_DECODE_PASSES = 8;
const ERROR_REASONS = new Set([
  "invalid_response",
  "invalid_account_id",
  "invalid_project_id",
  "plugin_mark_mismatch",
  "api_key_mismatch",
  "invalid_key_prefix",
  "invalid_created",
  "invalid_api_key_recovered",
  "invalid_warn_remaining_threshold",
  "invalid_warn_remaining_step",
  "invalid_register_url",
]);

export class TrialProvisionContractError extends Error {
  constructor(reason) {
    const safeReason = ERROR_REASONS.has(reason) ? reason : "invalid_response";
    super(`Trial provision response is invalid (${safeReason})`);
    this.name = "TrialProvisionContractError";
    this.code = "TRIAL_PROVISION_RESPONSE_INVALID";
    this.reason = safeReason;
  }
}

export function mapTrialProvisionResponse(response, options) {
  return mapResponse(response, options);
}

export function safeTrialRegisterUrl(value) {
  return httpsUrl(value);
}

function mapResponse(response, options) {
  const expectedPluginMark = options?.expectedPluginMark;
  if (typeof expectedPluginMark !== "string" || !PLUGIN_MARK_PATTERN.test(expectedPluginMark)) {
    throw new TypeError(
      "Trial provision mapping requires a valid expected plugin mark",
    );
  }
  const expectedApiKey = options?.expectedApiKey;
  if (typeof expectedApiKey !== "string" || !API_KEY_PATTERN.test(expectedApiKey)) {
    throw new TypeError(
      "Trial provision mapping requires a valid expected API key",
    );
  }
  const snapshot = snapshotProvisionResponse(response);

  const accountId = decimalPublicId(snapshot.user_id);
  if (!accountId) fail("invalid_account_id");
  const projectId = decimalPublicId(snapshot.project_id);
  if (!projectId) fail("invalid_project_id");
  if (snapshot.plugin_mark !== expectedPluginMark) fail("plugin_mark_mismatch");
  if (snapshot.api_key !== expectedApiKey) fail("api_key_mismatch");

  const keyPrefix = nonEmptyString(snapshot.key_prefix);
  if (!keyPrefix) fail("invalid_key_prefix");
  if (typeof snapshot.created !== "boolean") fail("invalid_created");
  if (typeof snapshot.api_key_recovered !== "boolean") fail("invalid_api_key_recovered");
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
  if (!safeTrialRegisterUrl(snapshot.register_url)) fail("invalid_register_url");

  return Object.freeze({
    accountId,
    projectId,
    created: snapshot.created,
    apiKeyRecovered: snapshot.api_key_recovered,
    warnRemainingThreshold: snapshot.warn_remaining_threshold,
    warnRemainingStep: snapshot.warn_remaining_step,
    registerUrl: snapshot.register_url,
  });
}

function snapshotProvisionResponse(response) {
  if (!isRecord(response)) fail("invalid_response");
  return {
    user_id: response.user_id,
    project_id: response.project_id,
    plugin_mark: response.plugin_mark,
    api_key: response.api_key,
    key_prefix: response.key_prefix,
    created: response.created,
    api_key_recovered: response.api_key_recovered,
    warn_remaining_threshold: response.warn_remaining_threshold,
    warn_remaining_step: response.warn_remaining_step,
    register_url: response.register_url,
  };
}

function fail(reason) {
  throw new TrialProvisionContractError(reason);
}

function decimalPublicId(value) {
  return typeof value === "string" && DECIMAL_PUBLIC_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function httpsUrl(value) {
  if (typeof value !== "string"
    || !value
    || value !== value.trim()
    || containsApiKey(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !containsApiKey(url.href)
      ? value
      : undefined;
  } catch {
    return undefined;
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

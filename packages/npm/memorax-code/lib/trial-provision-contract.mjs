const DECIMAL_PUBLIC_ID_PATTERN = /^[0-9]+$/;
const PLUGIN_MARK_PATTERN = /^mk_[0-9a-f]{32}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;

export class TrialProvisionContractError extends Error {
  constructor(reason) {
    super(`Trial provision response is invalid (${reason})`);
    this.name = "TrialProvisionContractError";
    this.code = "TRIAL_PROVISION_RESPONSE_INVALID";
    this.reason = reason;
  }
}

export function mapTrialProvisionResponse(response, options) {
  const expectedPluginMark = options?.expectedPluginMark;
  if (typeof expectedPluginMark !== "string" || !PLUGIN_MARK_PATTERN.test(expectedPluginMark)) {
    throw new TypeError("Trial provision mapping requires a valid expected plugin mark");
  }
  const expectedApiKey = options?.expectedApiKey;
  if (typeof expectedApiKey !== "string" || !API_KEY_PATTERN.test(expectedApiKey)) {
    throw new TypeError("Trial provision mapping requires a valid expected API key");
  }
  if (!isRecord(response)) fail("invalid_response");

  const accountId = decimalPublicId(response.user_id);
  if (!accountId) fail("invalid_account_id");
  const projectId = decimalPublicId(response.project_id);
  if (!projectId) fail("invalid_project_id");
  if (response.plugin_mark !== expectedPluginMark) fail("plugin_mark_mismatch");
  if (response.api_key !== expectedApiKey) fail("api_key_mismatch");

  const keyPrefix = nonEmptyString(response.key_prefix);
  if (!keyPrefix) fail("invalid_key_prefix");
  if (typeof response.created !== "boolean") fail("invalid_created");
  if (typeof response.api_key_recovered !== "boolean") fail("invalid_api_key_recovered");
  if (!nonNegativeSafeInteger(response.warn_remaining_threshold)) {
    fail("invalid_warn_remaining_threshold");
  }
  if (!positiveSafeInteger(response.warn_remaining_step)) {
    fail("invalid_warn_remaining_step");
  }
  if (!httpsUrl(response.register_url, expectedApiKey)) fail("invalid_register_url");

  return Object.freeze({
    accountId,
    projectId,
    created: response.created,
    apiKeyRecovered: response.api_key_recovered,
    warnRemainingThreshold: response.warn_remaining_threshold,
    warnRemainingStep: response.warn_remaining_step,
    registerUrl: response.register_url,
  });
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

function httpsUrl(value, apiKey) {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    const decodedUrl = decodeURIComponent(url.href);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !decodedUrl.includes(apiKey)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const DEFAULT_REPO_MEMORY_UPDATE_POLICY = "daily";
export const DEFAULT_REPO_MEMORY_COMMIT_THRESHOLD = 5;
export const DEFAULT_REPO_MEMORY_COOLDOWN_HOURS = 72;

export const REPO_MEMORY_UPDATE_POLICIES = Object.freeze([
  "every-commit",
  "commit-count",
  "daily",
  "pull-request",
  "pull-request-or-daily",
  "adaptive",
]);

export function resolveRepoMemoryUpdatePolicy(input = {}) {
  const rawPolicy = stringOption(input.policy)?.toLowerCase();
  const policy = REPO_MEMORY_UPDATE_POLICIES.includes(rawPolicy)
    ? rawPolicy
    : DEFAULT_REPO_MEMORY_UPDATE_POLICY;
  return {
    policy,
    policySource: !rawPolicy ? "default" : policy === rawPolicy ? "configured" : "invalid_fallback",
    commitThreshold: positiveInteger(input.commitThreshold, DEFAULT_REPO_MEMORY_COMMIT_THRESHOLD),
    cooldownHours: positiveNumber(input.cooldownHours, DEFAULT_REPO_MEMORY_COOLDOWN_HOURS),
  };
}

export function evaluateRepoMemoryUpdatePolicy(input = {}) {
  const settings = resolveRepoMemoryUpdatePolicy(input);
  const commitsBehind = nonNegativeInteger(input.commitsBehind);
  const pullRequestDetected = input.pullRequestDetected === true;
  const age = ageHours(input);
  const baselineStatus = stringOption(input.baselineStatus) || "ancestor";

  if (baselineStatus === "missing") {
    return decision(settings, {
      trigger: true,
      reason: "missing_baseline",
      ageHours: age,
      commitsBehind,
      pullRequestDetected,
      baselineStatus,
    });
  }
  if (baselineStatus === "not_ancestor") {
    return decision(settings, {
      trigger: true,
      reason: "baseline_not_ancestor",
      ageHours: age,
      commitsBehind,
      pullRequestDetected,
      baselineStatus,
    });
  }
  if (commitsBehind === 0) {
    return decision(settings, {
      trigger: false,
      reason: undefined,
      ageHours: age,
      commitsBehind,
      pullRequestDetected,
      baselineStatus,
    });
  }

  const cooldownElapsed = age === undefined || age >= settings.cooldownHours;
  const commitThresholdReached = commitsBehind >= settings.commitThreshold;
  let reason;
  if (settings.policy === "every-commit") {
    reason = "pending_commit";
  } else if (settings.policy === "commit-count") {
    reason = commitThresholdReached ? "commit_threshold_reached" : undefined;
  } else if (settings.policy === "daily") {
    reason = cooldownElapsed ? "cooldown_elapsed" : undefined;
  } else if (settings.policy === "pull-request") {
    reason = pullRequestDetected ? "pull_request_detected" : undefined;
  } else if (settings.policy === "pull-request-or-daily") {
    reason = pullRequestDetected
      ? "pull_request_detected"
      : cooldownElapsed
        ? "cooldown_elapsed"
        : undefined;
  } else {
    reason = commitThresholdReached
      ? "commit_threshold_reached"
      : cooldownElapsed
        ? "cooldown_elapsed"
        : undefined;
  }

  return decision(settings, {
    trigger: reason !== undefined,
    reason,
    ageHours: age,
    commitsBehind,
    pullRequestDetected,
    baselineStatus,
  });
}

export function parseRepoMemoryUpdatePolicyConfig(text) {
  const config = {};
  let section = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "memory.repo_update") continue;
    const field = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
    if (!field) continue;
    const key = field[1];
    const rawValue = field[2].trim().replace(/^['"]|['"]$/g, "");
    if (key === "policy") config.policy = rawValue;
    else if (key === "commit_threshold") config.commitThreshold = positiveInteger(rawValue, undefined);
    else if (key === "cooldown_hours") config.cooldownHours = positiveNumber(rawValue, undefined);
  }
  return config;
}

function decision(settings, fields) {
  return {
    ...settings,
    trigger: fields.trigger,
    reason: fields.reason,
    ageHours: fields.ageHours,
    commitsBehind: fields.commitsBehind,
    pullRequestDetected: fields.pullRequestDetected,
    baselineStatus: fields.baselineStatus,
  };
}

function ageHours(input) {
  const nowMs = finiteNumber(input.nowMs, Date.now());
  const lastUpdatedAtMs = finiteNumber(input.lastUpdatedAtMs, undefined);
  if (lastUpdatedAtMs === undefined) return undefined;
  return Math.max(0, nowMs - lastUpdatedAtMs) / (60 * 60 * 1000);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  if (parsed === Number.POSITIVE_INFINITY) return parsed;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

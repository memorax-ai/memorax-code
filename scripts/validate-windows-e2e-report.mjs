#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const boolean = { type: "boolean" };
const string = { type: "string", nonEmpty: true };
const number = { type: "number", integer: true, min: 0 };

function schema(keys, overrides = {}) {
  return Object.fromEntries(keys.map((key) => [key, overrides[key] ?? boolean]));
}

const schemas = {
  lifecycle: schema([
    "npmInstallOk",
    "packageIdentityExact",
    "productionDependencyReady",
    "allBinShimsRunnable",
    "cmdLifecycleVerified",
    "interruptedInstallRecovered",
    "backendLifecycleThreeCycles",
    "pidChangedOnRestart",
    "stopRemovedProcess",
    "portReleased",
    "updateReady",
    "sentinelCreated",
    "installedVersion",
  ], {
    installedVersion: string,
  }),
  updated: schema([
    "updateInstalledNewVersion",
    "oldPidRemoved",
    "newPidHealthy",
    "versionAdvanced",
    "partialUninstallOk",
    "partialUninstallKeptPackage",
    "partialUninstallKeptState",
    "backendRestartedAfterPartialUninstall",
    "uninstallCommandOk",
    "uninstallRemovedProcess",
    "uninstallReleasedPort",
    "uninstallRemovedPackage",
    "managedChildProcessesRemoved",
    "userStatePreserved",
    "sentinelBytesPreserved",
    "installedVersion",
    "expectedVersion",
    "baselineVersion",
  ], {
    installedVersion: string,
    expectedVersion: string,
    baselineVersion: string,
  }),
  codex: schema([
    "npmInstallOk",
    "clientProviderConfigPreserved",
    "pluginInstalled",
    "pluginHooksTrusted",
    "pluginVersionExact",
    "hookAssetsPresent",
    "ensureBackendHookStarted",
    "backendHealthy",
    "adapterReady",
    "sessionStartHookExecuted",
    "userPromptHookExecuted",
    "writebackHookExecuted",
    "hookAuthForwarded",
    "workspaceCwdExact",
    "sessionRegistryExact",
    "stopRemovedProcess",
    "restartHealthy",
    "uninstallRemovedProcess",
    "uninstallReleasedPort",
    "uninstallRemovedPlugin",
    "pluginRegistrationRemoved",
    "pluginCacheRemoved",
    "npmPackageRemoved",
    "managedChildProcessesRemoved",
    "userStatePreserved",
    "sentinelBytesPreserved",
  ]),
  claude: schema([
    "npmInstallOk",
    "clientProviderSettingsPreserved",
    "pluginInstalled",
    "pluginEnabled",
    "pluginVersionExact",
    "hookAssetsPresent",
    "initialBackendHealthy",
    "stopRemovedProcess",
    "ensureBackendHookStarted",
    "backendHealthy",
    "restartHealthy",
    "adapterReady",
    "sessionStartHookExecuted",
    "userPromptTurnStartHookExecuted",
    "userPromptReminderHookExecuted",
    "writebackHookExecuted",
    "hookAuthForwarded",
    "workspaceCwdExact",
    "sessionRegistryExact",
    "uninstallRemovedProcess",
    "uninstallReleasedPort",
    "uninstallRemovedPlugin",
    "pluginRegistrationRemoved",
    "npmPackageRemoved",
    "managedChildProcessesRemoved",
    "userStatePreserved",
    "sentinelBytesPreserved",
  ]),
  failure: {
    job: { type: "string", enum: ["package", "codex", "claude"] },
    packageVersions: {
      type: "object",
      schema: {
        package: { type: "nullable-string" },
        codexAdapter: { type: "nullable-string" },
        claudeAdapter: { type: "nullable-string" },
      },
    },
    backend: {
      type: "object",
      schema: {
        statePresent: boolean,
        pidValid: boolean,
        pidAlive: boolean,
        instancePresent: boolean,
        health: {
          type: "string",
          enum: ["healthy", "unreachable", "mismatch", "absent"],
        },
      },
    },
    process: {
      type: "object",
      schema: {
        installedPrefixReferences: number,
      },
    },
    assertions: {
      type: "object",
      schema: {
        reportPresent: boolean,
        trueCount: number,
        falseCount: number,
      },
    },
    backendLogTail: {
      type: "array",
      items: { type: "string" },
      maxLength: 40,
    },
  },
};

function validateExactObject(value, objectSchema, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = Object.keys(objectSchema).sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys do not match the required schema`);
  }
  for (const [key, rule] of Object.entries(objectSchema)) {
    validateRule(value[key], rule, `${label}.${key}`);
  }
}

function validateRule(value, rule, label) {
  if (rule.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  if (rule.type === "string"
    && (typeof value !== "string" || (rule.nonEmpty && !value))) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (rule.type === "nullable-string"
    && value !== null
    && typeof value !== "string") {
    throw new Error(`${label} must be string or null`);
  }
  if (rule.type === "number"
    && (typeof value !== "number"
      || !Number.isFinite(value)
      || (rule.integer && !Number.isInteger(value))
      || value < (rule.min ?? -Infinity))) {
    throw new Error(`${label} must be a valid number`);
  }
  if (rule.type === "object") validateExactObject(value, rule.schema, label);
  if (rule.type === "array") {
    if (!Array.isArray(value)
      || (rule.maxLength !== undefined && value.length > rule.maxLength)) {
      throw new Error(`${label} must be a bounded array`);
    }
    value.forEach((item, index) => validateRule(item, rule.items, `${label}[${index}]`));
  }
  if (rule.enum && !rule.enum.includes(value)) {
    throw new Error(`${label} has an unsupported value`);
  }
}

const [kind, path] = process.argv.slice(2);
if (!path || !schemas[kind]) {
  throw new Error(
    "usage: node scripts/validate-windows-e2e-report.mjs <lifecycle|updated|codex|claude|failure> REPORT",
  );
}
const raw = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
if (/Authorization|Bearer|api[_-]?key|token|[A-Z]:\\Users\\|(?:^|[\s"'])\/(?:Users|home)\//i.test(raw)) {
  throw new Error("E2E report contains a sensitive field or private path");
}
const report = JSON.parse(raw);
validateExactObject(report, schemas[kind], "report");
if (kind !== "failure") {
  for (const [key, value] of Object.entries(report)) {
    if (typeof value === "boolean" && value !== true) {
      throw new Error(`E2E assertion failed: ${key}`);
    }
  }
}
console.log(`${kind} E2E report passed exact schema and sensitive-data scan`);

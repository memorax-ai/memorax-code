#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePackagedClientHookRuntime } from "../lib/client-hook-runtime.mjs";
import { unsupportedNodeVersionMessage } from "../lib/node-version.mjs";
import { resolveNpmInvocation } from "../lib/npm-invocation.mjs";
import {
  captureBackendEntrypoint,
  runBackendEntrypoint,
  runBackendEntrypointChild,
} from "../lib/run-entrypoint.mjs";

const nodeVersionError = unsupportedNodeVersionMessage();
if (nodeVersionError) {
  console.error(`memorax-code: ${nodeVersionError}`);
  process.exit(1);
}

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
}

function printUpdateHelp() {
  console.log(`Usage: memorax-code update [--preview | --latest] [--force] [--home DIR] [--dry-run]

Update the globally installed MemoraX Code npm package.

Options:
  --preview   Follow the npm preview dist-tag
  --latest    Follow the npm latest dist-tag
  --force     Reinstall the selected channel with npm install --force
  --home DIR  Update the Backend managed under this MemoraX Code home
  --dry-run   Print the npm command without running it
  -h, --help  Show this help message`);
}

function printCommand(command, args) {
  console.log([command, ...args].join(" "));
}

function npmCommandCwd() {
  for (const candidate of [process.env.HOME, homedir(), "/"]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "/";
}

async function runUpdateCommand(args) {
  let dryRun = false;
  let force = false;
  let requestedChannel;
  let requestedHome;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--home") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        console.error("memorax-code update: --home requires a directory");
        printUpdateHelp();
        return 2;
      }
      requestedHome = resolve(value);
    } else if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length).trim();
      if (!value) {
        console.error("memorax-code update: --home requires a directory");
        printUpdateHelp();
        return 2;
      }
      requestedHome = resolve(value);
    } else if (arg === "--preview" || arg === "--latest") {
      const channel = arg.slice(2);
      if (requestedChannel && requestedChannel !== channel) {
        console.error("memorax-code update: --preview and --latest cannot be used together");
        printUpdateHelp();
        return 2;
      }
      requestedChannel = channel;
    } else if (arg === "--help" || arg === "-h") {
      printUpdateHelp();
      return 0;
    } else {
      console.error(`memorax-code update: unknown option ${arg}`);
      printUpdateHelp();
      return 2;
    }
  }

  const pkg = readPackageJson();
  const channel = requestedChannel ?? (pkg.version.includes("-") ? "preview" : "latest");
  const npmArgs = ["install", "-g", `${pkg.name}@${channel}`];
  if (force) npmArgs.push("--force");
  npmArgs.push("--foreground-scripts");

  if (dryRun) {
    printCommand("npm", npmArgs);
    return 0;
  }

  console.error(`memorax-code update: running ${["npm", ...npmArgs].join(" ")}`);
  const cwd = npmCommandCwd();
  let invocation;
  try {
    invocation = resolveNpmInvocation(npmArgs);
  } catch (error) {
    console.error(`memorax-code update: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const child = spawn(invocation.command, invocation.args, {
    stdio: "inherit",
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
      MEMORAX_CODE_NPM_POSTINSTALL_UPDATE: "1",
      ...(requestedHome ? { MEMORAX_CODE_HOME: requestedHome } : {}),
    },
  });
  return await new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`memorax-code update: failed to start npm: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        console.error(`memorax-code update: npm exited from signal ${signal}`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

if (process.argv[2] === "update") {
  process.exit(await runUpdateCommand(process.argv.slice(3)));
}

if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  const pkg = readPackageJson();
  console.log(`memorax-code ${pkg.version}`);
  process.exit(0);
}

if (shouldStageClientHookRuntime(process.argv.slice(2))
  && !truthyEnv(process.env.MEMORAX_CODE_DEFER_CLIENT_HOOK_RUNTIME_ACTIVATION)) {
  try {
    const memoraxCodeHome = requestedMemoraxCodeHome(process.argv.slice(2));
    const generation = await stagePackagedClientHookRuntime({
      packageRoot: packageRoot(),
      memoraxCodeHome,
    });
    process.env.MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1 = JSON.stringify({
      version: 1,
      memoraxCodeHome,
      generation: {
        version: generation.version,
        runtimeAbi: generation.runtimeAbi,
        generationId: generation.generationId,
        packageVersion: generation.packageVersion,
        contentDigest: generation.contentDigest,
        createdAt: generation.createdAt,
      },
    });
  } catch (error) {
    console.error(`memorax-code: failed to stage client Hook runtime: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const unifiedStatusExitCode = await runUnifiedStatus(process.argv.slice(2));
if (unifiedStatusExitCode !== undefined) process.exit(unifiedStatusExitCode);

const dshLifecycleExitCode = await runDshLifecycle(process.argv.slice(2));
if (dshLifecycleExitCode !== undefined) process.exit(dshLifecycleExitCode);

await runBackendEntrypoint("memorax-code.js");

async function runUnifiedStatus(args) {
  if (args[0] !== "status" || args.includes("--help") || args.includes("-h")) {
    return undefined;
  }
  let memoraxCodeHome;
  try {
    memoraxCodeHome = requestedMemoraxCodeHome(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const { collectDshAdapterStatus } = await import("../lib/dsh-plugin-install.mjs");
  const dshAdapter = collectDshAdapterStatus({ memoraxCodeHome });
  const backend = await captureBackendEntrypoint("memorax-code.js", args);
  if (backend.stderr) process.stderr.write(backend.stderr);

  if (args.includes("--json")) {
    let report;
    try {
      report = JSON.parse(backend.stdout);
    } catch {
      console.error("memorax-code: Backend status did not return valid JSON");
      return 1;
    }
    if (!validBackendStatusReport(report)) {
      console.error("memorax-code: Backend status returned an incompatible JSON report");
      return 1;
    }
    console.log(JSON.stringify({ ...report, dshAdapter }, null, 2));
    return backend.code;
  }

  if (backend.stdout) {
    process.stdout.write(backend.stdout);
    if (!backend.stdout.endsWith("\n")) process.stdout.write("\n");
  }
  printDshAdapterStatus(dshAdapter);
  return backend.code;
}

function printDshAdapterStatus(report) {
  const profiles = Array.isArray(report.profiles) ? report.profiles : [];
  const installedProfiles = profiles.filter((profile) => (
    profile.managed && profile.exists && profile.installed
  )).length;
  const version = report.version ? ` version=${report.version}` : "";
  const profileCount = ` profiles=${installedProfiles}/${profiles.length}`;
  const status = report.ok !== true
    ? `not ok ${report.reason ?? "unavailable"}`
    : report.enabled === true
      ? "ok"
      : report.skipped === true
        ? `skipped ${report.reason ?? "not-managed"}`
        : `not enabled ${report.reason ?? "not-ready"}`;
  console.log(`DSH adapter: ${status} integration=plugin${version}${profileCount}`);
  if (profiles.length > 0) {
    console.log(`DSH profiles: ${profiles.map((profile) => {
      const name = statusText(profile.name);
      if (!profile.exists) return `${name}=missing`;
      if (!profile.managed) return `${name}=unmanaged`;
      return `${name}=${profile.installed ? "installed" : "incomplete"}`;
    }).join(", ")}`);
  }
}

function validBackendStatusReport(value) {
  return Boolean(value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.action === "status"
    && typeof value.ok === "boolean"
    && value.backend
    && typeof value.backend === "object"
    && !Array.isArray(value.backend));
}

function statusText(value) {
  const sanitized = String(value).replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    "?",
  );
  return sanitized.length <= 120 ? sanitized : `${sanitized.slice(0, 117)}...`;
}

async function runDshLifecycle(args) {
  const command = args[0];
  if (!["start", "restart", "stop", "uninstall"].includes(command)
    || args.includes("--help")
    || args.includes("-h")) return undefined;

  const { withDshPluginLifecycleLock } = await import("../lib/dsh-plugin-install.mjs");
  const memoraxCodeHome = requestedMemoraxCodeHome(args);
  const options = {
    memoraxCodeHome,
    memoraxCodeCommand: fileURLToPath(import.meta.url),
  };
  const recoveryRevision = dshAdapterRecoveryRevision();
  try {
    return await withDshPluginLifecycleLock(options, async (lifecycle) => {
      const status = lifecycle.status();
      const detectedProfiles = lifecycle.discoverProfiles();
      if (isDshAdapterRecovery() && (
        !recoveryRevision
        || status.ok !== true
        || status.enabled !== true
        || status.revision !== recoveryRevision
      )) return 0;
      if (status.ok !== true) {
        printDshLifecycleFailure("status", status);
        return 1;
      }
      if (status.managed !== true && detectedProfiles.length === 0) {
        return isDshAdapterRecovery() ? 0 : undefined;
      }

      if (command === "start" || command === "restart") {
        const prepared = lifecycle.ensureInstalled({ enabled: false });
        if (prepared.ok !== true) {
          printDshLifecycleFailure("prepare", prepared);
          return 1;
        }
        if (prepared.skipped === true) printDshLifecycleSkip(prepared);
        const backendCode = await runBackendEntrypointChild("memorax-code.js", args);
        if (backendCode !== 0) return backendCode;
        if (prepared.installed !== true) return 0;
        const activated = lifecycle.activate();
        if (activated.ok !== true) {
          printDshLifecycleFailure("activate", activated);
          return 1;
        }
        return 0;
      }

      if (!shouldDisableDsh(args)) {
        if (status.authorityEnabled !== true) return undefined;
        return await runBackendEntrypointChild("memorax-code.js", args, {
          env: {
            ...process.env,
            MEMORAX_CODE_EXTERNAL_BACKEND_CLIENT_ACTIVE: "1",
          },
        });
      }
      const disabled = lifecycle.disable();
      if (disabled.ok !== true) {
        printDshLifecycleFailure("disable", disabled);
        return 1;
      }
      const backendCode = await runBackendEntrypointChild("memorax-code.js", args, {
        env: {
          ...process.env,
          MEMORAX_CODE_EXTERNAL_BACKEND_CLIENT_ACTIVE: "0",
        },
      });
      if (backendCode !== 0 || command !== "uninstall") return backendCode;
      const removed = lifecycle.remove();
      if (removed.ok !== true) {
        printDshLifecycleFailure("remove", removed);
        return 1;
      }
      return 0;
    });
  } catch (error) {
    console.error(`memorax-code: DSH lifecycle coordination failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function shouldDisableDsh(args) {
  return !hasExplicitClientSelection(args)
    || truthyEnv(process.env.MEMORAX_CODE_NPM_PREINSTALL_RETIRE_DSH);
}

function hasExplicitClientSelection(args) {
  return args.includes("--clients") || args.some((arg) => arg.startsWith("--clients="));
}

function printDshLifecycleFailure(operation, report) {
  const reason = typeof report?.reason === "string" ? ` (${report.reason})` : "";
  console.error(`memorax-code: DSH plugin ${operation} failed${reason}`);
}

function printDshLifecycleSkip(report) {
  if (report.reason === "unsupported_dsh_version") {
    console.error(`memorax-code: DSH integration skipped: version ${report.dshVersion ?? "unknown"} is unsupported (supported: ${(report.supportedDshVersions ?? []).join(", ") || "none"})`);
  } else if (report.reason === "dsh_version_unavailable") {
    console.error("memorax-code: DSH integration skipped: could not determine the DSH version");
  }
}

function shouldStageClientHookRuntime(args) {
  if (args.includes("--help") || args.includes("-h")) return false;
  if (isDshAdapterRecovery()) return false;
  return args[0] === "start" || args[0] === "restart";
}

function isDshAdapterRecovery() {
  return truthyEnv(process.env.MEMORAX_CODE_DSH_ADAPTER_RECOVERY);
}

function dshAdapterRecoveryRevision() {
  const value = process.env.MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestedMemoraxCodeHome(args) {
  const index = args.indexOf("--home");
  if (index >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--home requires a directory");
    return resolve(value);
  }
  const inline = args.find((arg) => arg.startsWith("--home="));
  if (inline) {
    const value = inline.slice("--home=".length);
    if (!value.trim()) throw new Error("--home requires a directory");
    return resolve(value);
  }
  return resolve(process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code"));
}

function truthyEnv(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

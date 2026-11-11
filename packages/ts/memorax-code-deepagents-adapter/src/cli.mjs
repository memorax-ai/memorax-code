#!/usr/bin/env node
import {
  DEFAULT_TOKEN_ENV,
  defaultDeepAgentsHome,
  defaultMemoraxCodeHome,
  readDeepAgentsAdapterStatus,
  readDeepAgentsWorkspaceStatus,
} from "./config.mjs";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";

const BACKEND_HEALTH_TIMEOUT_MS = 5_000;
const VALUE_OPTIONS = new Set([
  "--deepagents-home",
  "--memorax-code-home",
  "--backend-url",
  "--backend-token-env",
]);

try {
  const parsed = parseCli(process.argv);
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  const options = parsed.options;
  if (parsed.command === "status") {
    print(readDeepAgentsAdapterStatus(options), options);
  } else if (parsed.command === "doctor") {
    const [status, workspace, backend] = await Promise.all([
      readDeepAgentsAdapterStatus(options),
      readDeepAgentsWorkspaceStatus(options),
      backendHealth(options.backendUrl, backendToken(options)),
    ]);
    const adapterOk = status.ok
      && status.enabled === true
      && status.backendUrlMatches !== false
      && status.deepAgentsSkills?.ok === true;
    print({ ok: adapterOk && backend.ok, action: "doctor", status, workspace, backend }, options);
  } else {
    throw new Error(`unknown command: ${parsed.command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function printHelp() {
  console.log([
    "Usage: memorax-code-deepagents [status|doctor] [options]",
    "",
    "Lifecycle note: use `memorax-code start` and `memorax-code stop` to enable or disable adapters; add `--clients deepagents` for Deep Agents Code only.",
    "",
    "Options:",
    "  --deepagents-home DIR   Deep Agents profile home (default: DEEPAGENTS_HOME or ~/.deepagents)",
    "  --memorax-code-home DIR MemoraX Code state home (default: MEMORAX_CODE_HOME or ~/.memorax-code)",
    "  --backend-url URL       Local Backend URL (default: persisted connection or http://127.0.0.1:8787)",
    "  --backend-token-env NAME Token env var for local Memory Service auth",
    "  --json                  Print machine-readable JSON",
  ].join("\n"));
}

function parseCli(argv) {
  const args = argv.slice(2);
  const first = args[0];
  const command = first && !first.startsWith("-") ? first : "status";
  const optionArgs = command === first ? args.slice(1) : args;
  const help = command === "help" || optionArgs.includes("--help");
  return { command, help, options: help ? {} : parseOptions(optionArgs, command === "status" || command === "doctor") };
}

function parseOptions(args, resolveConnection) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" || arg === "--help") {
      values[arg] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values[arg] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }
  const memoraxCodeHome = values["--memorax-code-home"] ?? defaultMemoraxCodeHome();
  let backendUrl;
  if (resolveConnection) {
    backendUrl = resolveBackendConnection({
      memoraxCodeHome,
      backendUrl: values["--backend-url"],
    }).url;
  }
  return {
    deepAgentsHome: values["--deepagents-home"] ?? defaultDeepAgentsHome(),
    memoraxCodeHome,
    ...(backendUrl ? { backendUrl } : {}),
    backendTokenEnv: values["--backend-token-env"],
    json: Boolean(values["--json"]),
  };
}

async function backendHealth(backendUrl, token) {
  try {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = await fetch(new URL("/health", backendUrl), {
      headers,
      signal: AbortSignal.timeout(BACKEND_HEALTH_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => undefined);
    return { ok: response.ok && body?.ok === true && body?.service === "memorax-code-backend", status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function backendToken(options) {
  const tokenEnv = options.backendTokenEnv ?? DEFAULT_TOKEN_ENV;
  if (tokenEnv !== DEFAULT_TOKEN_ENV) return tokenEnv ? process.env[tokenEnv] : undefined;
  return resolveBackendConnection({
    memoraxCodeHome: options.memoraxCodeHome,
    backendUrl: options.backendUrl,
  }).token;
}

function print(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.action === "status") {
    printStatus(result);
  } else if (result.action === "doctor") {
    printDoctor(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(result.ok ? 0 : 1);
}

function printStatus(result) {
  console.log(`status: ${result.enabled === true && result.backendUrlMatches !== false && result.deepAgentsSkills?.ok === true ? "ok" : "not enabled"}`);
  console.log(`deepagents home: ${result.deepAgentsHome}`);
  console.log(`memorax-code home: ${result.memoraxCodeHome}`);
  console.log(`state: ${result.statePath}`);
  console.log("integration: plugin");
  console.log("provider config: unchanged (Deep Agents Code-owned)");
  console.log(`adapter state: ${check(Boolean(result.state && !result.state.unreadable))}`);
  console.log(`backend endpoint: ${check(result.backendUrlMatches !== false)} configured=${result.configuredBackendUrl ?? "missing"} expected=${result.expectedBackendUrl ?? "unknown"}`);
}

function printDoctor(result) {
  console.log(`doctor: ${result.ok ? "ok" : "needs attention"}`);
  printStatus(result.status);
  console.log(`workspace capture: ${check(result.workspace?.captured === true)}`);
  console.log(`memory service health: ${check(result.backend?.ok === true)}`);
}

function check(ok) {
  return ok ? "ok" : "not ok";
}

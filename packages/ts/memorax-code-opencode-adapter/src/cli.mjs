#!/usr/bin/env node
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import {
  defaultMemoraxCodeHome,
  defaultOpenCodeConfigDir,
} from "./adapter-paths.mjs";
import { readOpenCodeWorkspaceStatus } from "./diagnostics.mjs";
import { readOpenCodePluginStatus } from "./plugin-install.mjs";

const DEFAULT_TOKEN_ENV = "MEMORAX_CODE_BACKEND_TOKEN";
const BACKEND_HEALTH_TIMEOUT_MS = 5_000;
const VALUE_OPTIONS = new Set([
  "--opencode-config-dir",
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
    print(openCodeStatus(options), options);
  } else if (parsed.command === "doctor") {
    const [status, workspace, backend] = await Promise.all([
      openCodeStatus(options),
      readOpenCodeWorkspaceStatus(options),
      backendHealth(options.backendUrl, backendToken(options)),
    ]);
    print({
      ok: status.ok && workspace.ok && workspace.captured && backend.ok,
      action: "doctor",
      status,
      workspace,
      backend,
    }, options);
  } else {
    throw new Error(`unknown command: ${parsed.command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function printHelp() {
  console.log([
    "Usage: memorax-code-opencode [status|doctor] [options]",
    "",
    "Lifecycle note: use `memorax-code start --clients opencode` to install or reconcile the OpenCode plugin.",
    "",
    "Options:",
    "  --opencode-config-dir DIR  OpenCode config root (default: OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME/opencode, or ~/.config/opencode)",
    "  --memorax-code-home DIR    MemoraX Code state home (default: MEMORAX_CODE_HOME or ~/.memorax-code)",
    "  --backend-url URL           Local Backend URL (default: persisted connection or http://127.0.0.1:8787)",
    "  --backend-token-env NAME    Token env var for Backend health checks",
    "  --json                      Print machine-readable JSON",
  ].join("\n"));
}

function parseCli(argv) {
  const args = argv.slice(2);
  const first = args[0];
  const command = first && !first.startsWith("-") ? first : "status";
  const optionArgs = command === first ? args.slice(1) : args;
  const help = command === "help" || optionArgs.includes("--help");
  return {
    command,
    help,
    options: help ? {} : parseOptions(optionArgs),
  };
}

function parseOptions(args) {
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
  const requestedBackendUrl = values["--backend-url"] ?? process.env.MEMORAX_CODE_BACKEND_URL;
  if (requestedBackendUrl) validateHttpUrl(requestedBackendUrl, "--backend-url");
  const connection = resolveBackendConnection({
    memoraxCodeHome,
    backendUrl: values["--backend-url"],
  });
  return {
    openCodeConfigDir: values["--opencode-config-dir"] ?? defaultOpenCodeConfigDir(),
    memoraxCodeHome,
    backendUrl: connection.url,
    backendTokenEnv: values["--backend-token-env"],
    connection,
    json: Boolean(values["--json"]),
  };
}

function openCodeStatus(options) {
  const status = readOpenCodePluginStatus(options);
  const openCodeConfigDir = typeof status.state?.openCodeConfigDir === "string"
    ? status.state.openCodeConfigDir
    : options.openCodeConfigDir;
  const ready = status.ok === true
    && status.installed === true
    && status.enabled === true
    && status.current === true
    && status.backendUrlMatches !== false
    && status.opencodeSkills?.ok === true;
  return {
    ...status,
    ok: ready,
    action: "status",
    openCodeConfigDir,
    ...(openCodeConfigDir !== options.openCodeConfigDir
      ? { requestedOpenCodeConfigDir: options.openCodeConfigDir }
      : {}),
    memoraxCodeHome: options.memoraxCodeHome,
  };
}

function validateHttpUrl(value, optionName) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error(`${optionName} must be an http(s) URL`);
  }
}

async function backendHealth(backendUrl, token) {
  try {
    const headers = {
      connection: "close",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const response = await fetch(new URL("/health", backendUrl), {
      headers,
      signal: AbortSignal.timeout(BACKEND_HEALTH_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => undefined);
    return {
      ok: response.ok && body?.ok === true && body?.service === "memorax-code-backend",
      status: response.status,
      body,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function backendToken(options) {
  const tokenEnv = options.backendTokenEnv ?? DEFAULT_TOKEN_ENV;
  return tokenEnv === DEFAULT_TOKEN_ENV
    ? options.connection.token
    : process.env[tokenEnv];
}

function print(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.action === "doctor") {
    printDoctor(result);
  } else {
    printStatus(result);
  }
  process.exit(result.ok ? 0 : 1);
}

function printStatus(result, includeHints = true) {
  console.log(`status: ${result.ok ? "ok" : "needs attention"}`);
  console.log(`opencode config: ${result.openCodeConfigDir}`);
  if (result.requestedOpenCodeConfigDir) {
    console.log(`requested opencode config: ${result.requestedOpenCodeConfigDir}`);
  }
  console.log(`memorax-code home: ${result.memoraxCodeHome}`);
  console.log(`state: ${result.statePath}`);
  console.log("integration: plugin");
  console.log("provider config: unchanged (OpenCode-owned)");
  console.log(`managed plugin: ${check(result.pluginExists && result.pluginCurrent)}`);
  console.log(`memorax-code skill: ${check(result.skillExists && result.skillCurrent)}`);
  console.log(`repo-memory helper: ${check(result.repoMemoryHelperExists && result.repoMemoryHelperCurrent)}`);
  console.log(`backend endpoint: ${check(result.backendUrlMatches !== false)} configured=${result.configuredBackendUrl ?? "missing"} expected=${result.expectedBackendUrl ?? "unknown"}`);
  if (includeHints) printHints(statusHints(result));
}

function printDoctor(result) {
  console.log(`doctor: ${result.ok ? "ok" : "needs attention"}`);
  printStatus(result.status, false);
  console.log(`plugin runtime evidence: ${check(result.workspace?.captured === true)}${workspaceDetail(result.workspace)}`);
  console.log(`backend health: ${check(result.backend?.ok === true)}${backendDetail(result.backend)}`);
  printHints(doctorHints(result));
}

function check(ok) {
  return ok ? "ok" : "not ok";
}

function workspaceDetail(workspace) {
  if (!workspace) return " missing";
  if (workspace.ok === false) return ` ${workspace.reason ?? "invalid"} (${workspace.path})`;
  if (!workspace.captured) return ` not observed (${workspace.path})`;
  const latest = workspace.latest;
  const event = typeof latest?.event === "string" ? ` event=${latest.event}` : "";
  const cwd = typeof latest?.cwd === "string" ? ` cwd=${latest.cwd}` : "";
  const capturedAt = typeof latest?.capturedAt === "string" ? ` at=${latest.capturedAt}` : "";
  return `${event}${cwd}${capturedAt}`;
}

function backendDetail(backend) {
  if (!backend) return " missing";
  if (backend.ok) return backend.status ? ` status=${backend.status}` : "";
  return ` ${backend.error ?? backend.status ?? "not reachable"}`;
}

function statusHints(result) {
  const hints = [];
  if (result.installed !== true || result.enabled !== true || result.current !== true) {
    hints.push("Install or reconcile the managed integration with `memorax-code start --clients opencode`, then restart or refresh OpenCode.");
  }
  if (result.backendUrlMatches === false) {
    hints.push("Adapter state points at a different Backend endpoint; rerun `memorax-code start --clients opencode`.");
  }
  return hints;
}

function doctorHints(result) {
  const hints = [...statusHints(result.status)];
  if (result.backend?.ok !== true) {
    hints.push("Backend is not reachable; start it with `memorax-code start` or pass the correct `--backend-url`.");
  }
  if (result.workspace?.ok === false) {
    hints.push("OpenCode runtime evidence is unreadable or invalid; inspect or remove that state file, then restart or refresh OpenCode.");
  } else if (result.workspace?.captured !== true) {
    hints.push("No OpenCode plugin runtime has been observed yet; restart or refresh OpenCode, then rerun this command.");
  }
  return [...new Set(hints)];
}

function printHints(hints) {
  if (hints.length === 0) return;
  console.log("");
  console.log("Recommended next steps:");
  for (const hint of hints) console.log(`- ${hint}`);
}

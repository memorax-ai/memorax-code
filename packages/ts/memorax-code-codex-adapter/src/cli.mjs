#!/usr/bin/env node
import {
  DEFAULT_TOKEN_ENV,
  defaultCodexHome,
  defaultMemoraxCodeHome,
  inspectCodexHistory,
  readCodexAdapterStatus,
  readCodexWorkspaceStatus,
  readMergedCodexSessions,
  updateCodexSessionRegistry,
} from "./config.mjs";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";

const BACKEND_HEALTH_TIMEOUT_MS = 5_000;
const VALUE_OPTIONS = new Set([
  "--codex-home",
  "--memorax-code-home",
  "--backend-url",
  "--backend-token-env",
  "--session-id",
  "--title",
  "--transcript-path",
  "--workspace",
  "--max-files",
]);

try {
  const parsed = parseCli(process.argv);
  const command = parsed.command;
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  const options = parsed.options;
  if (command === "status") {
    print(readCodexAdapterStatus(options), options);
  } else if (command === "inspect-history") {
    print(inspectCodexHistory(options), options);
  } else if (command === "sessions") {
    print(readMergedCodexSessions(options), options);
  } else if (command === "mark-session") {
    print(updateCodexSessionRegistry(options), options);
  } else if (command === "doctor") {
    const [status, workspace, backend] = await Promise.all([
      readCodexAdapterStatus(options),
      readCodexWorkspaceStatus(options),
      backendHealth(options.backendUrl, backendToken(options)),
    ]);
    const adapterOk = status.ok
      && status.enabled === true
      && status.backendUrlMatches !== false
      && status.codexSkills?.ok === true;
    print({
      ok: adapterOk && backend.ok,
      action: "doctor",
      status,
      workspace,
      backend,
    }, options);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function printHelp() {
  console.log([
    "Usage: memorax-code-codex [status|doctor|inspect-history|sessions|mark-session] [options]",
    "",
    "Lifecycle note: use `memorax-code start` and `memorax-code stop` to enable or disable the Codex Hook adapter.",
    "",
    "Options:",
    "  --codex-home DIR          Codex home to inspect (default: CODEX_HOME or ~/.codex)",
    "  --memorax-code-home DIR        MemoraX Code state home (default: MEMORAX_CODE_HOME or ~/.memorax-code)",
    "  --backend-url URL         Local Backend URL (default: persisted connection or http://127.0.0.1:8787)",
    "  --backend-token-env NAME  Token env var for Backend health checks",
    "  --session-id ID           Adapter session id for mark-session",
    "  --title TEXT              Optional session title for mark-session",
    "  --transcript-path FILE    Optional Codex transcript path for mark-session",
    "  --workspace DIR           Optional workspace path for mark-session",
    "  --max-files N             Max native session files to inspect (default: 500)",
    "  --json                    Print machine-readable JSON",
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
    options: help ? {} : parseOptions(optionArgs, command === "status" || command === "doctor"),
  };
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
    const requestedBackendUrl = values["--backend-url"] ?? process.env.MEMORAX_CODE_BACKEND_URL;
    if (requestedBackendUrl) validateHttpUrl(requestedBackendUrl, "--backend-url");
    backendUrl = resolveBackendConnection({
      memoraxCodeHome,
      backendUrl: values["--backend-url"],
    }).url;
  }
  const maxFiles = values["--max-files"] ? parseNonNegativeInteger(values["--max-files"], "--max-files") : undefined;
  return {
    codexHome: values["--codex-home"] ?? defaultCodexHome(),
    memoraxCodeHome,
    ...(backendUrl ? { backendUrl } : {}),
    backendTokenEnv: values["--backend-token-env"],
    sessionId: values["--session-id"],
    title: values["--title"],
    transcriptPath: values["--transcript-path"],
    workspace: values["--workspace"],
    maxFiles,
    json: Boolean(values["--json"]),
  };
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateHttpUrl(value, optionName) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error(`${optionName} must be an http(s) URL`);
  }
}

function parseNonNegativeInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${optionName} must be a non-negative integer`);
  return parsed;
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
  } else if (result.action === "inspect-history") {
    printInspectHistory(result);
  } else if (result.action === "sessions") {
    printSessions(result);
  } else if (result.action === "mark-session") {
    printMarkSession(result);
  } else if (result.ok) {
    console.log(`${result.action}: ok`);
    if (result.statePath) console.log(`state: ${result.statePath}`);
    printCodexSkills(result.codexSkills);
    if (result.workspace) {
      console.log(`workspace: ${result.workspace.realpath ?? result.workspace.path}`);
    }
    if (result.backend?.ok === false) console.log(`backend: ${result.backend.error ?? result.backend.status ?? "not ok"}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(result.ok ? 0 : 1);
}

function printStatus(result) {
  console.log(`status: ${result.enabled === true && result.backendUrlMatches !== false && result.codexSkills?.ok === true ? "ok" : "not enabled"}`);
  console.log(`codex home: ${result.codexHome}`);
  console.log(`memorax-code home: ${result.memoraxCodeHome}`);
  console.log(`state: ${result.statePath}`);
  console.log("integration: hooks");
  console.log("provider config: unchanged (Codex-owned)");
  console.log(`adapter state: ${check(Boolean(result.state && !result.state.unreadable))}${stateDetail(result.state)}`);
  console.log(`backend endpoint: ${check(result.backendUrlMatches !== false)} configured=${result.configuredBackendUrl ?? "missing"} expected=${result.expectedBackendUrl ?? "unknown"}`);
  printCodexSkills(result.codexSkills);
  printHints(statusHints(result));
}

function printDoctor(result) {
  console.log(`doctor: ${result.ok ? "ok" : "needs attention"}`);
  printStatus(result.status);
  console.log(`workspace capture: ${check(result.workspace?.captured === true)}${workspaceDetail(result.workspace)}`);
  console.log(`backend health: ${check(result.backend?.ok === true)}${backendDetail(result.backend)}`);
  printHints(doctorHints(result));
}

function printInspectHistory(result) {
  console.log(`inspect-history: ${result.ok ? "ok" : "needs attention"}`);
  console.log(`codex home: ${result.codexHome}`);
  console.log(`native sessions root: ${result.native.sessionsRoot} ${result.native.sessionsRootExists ? "(found)" : "(missing)"}`);
  console.log(`native session files: ${result.native.sessionCount}`);
  console.log(`memorax-code registry: ${result.memoraxCode.registryPath} ${result.memoraxCode.registryExists ? "(found)" : "(missing)"}`);
  console.log(`memorax-code workspace state: ${result.memoraxCode.workspaceStatePath} ${result.memoraxCode.workspaceStateExists ? "(found)" : "(missing)"}`);
}

function printSessions(result) {
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`sessions: ${result.ok ? "ok" : "needs attention"}`);
  console.log(`session count: ${result.sessionCount}`);
  for (const session of result.sessions.slice(0, 20)) {
    const title = session.title ? ` ${session.title}` : "";
    const workspace = session.workspace ? ` workspace=${session.workspace}` : "";
    const path = session.relativePath ? ` path=${session.relativePath}` : "";
    console.log(`- ${session.key}${title}${workspace}${path}`);
  }
}

function printMarkSession(result) {
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("mark-session: ok");
  console.log(`registry: ${result.path}`);
  console.log(`session: ${result.session.key}`);
}

function check(ok) {
  return ok ? "ok" : "not ok";
}

function stateDetail(state) {
  if (!state) return " missing";
  if (state.unreadable) return " unreadable";
  const parts = [
    state.integration ? `integration=${state.integration}` : undefined,
    typeof state.enabled === "boolean" ? `enabled=${state.enabled}` : undefined,
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function workspaceDetail(workspace) {
  if (!workspace) return " missing";
  if (!workspace.captured) return ` no cwd captured (${workspace.path})`;
  const latest = workspace.latest;
  const cwd = typeof latest?.cwd === "string" ? latest.cwd : "unknown cwd";
  const capturedAt = typeof latest?.capturedAt === "string" ? ` at ${latest.capturedAt}` : "";
  return ` ${cwd}${capturedAt}`;
}

function backendDetail(backend) {
  if (!backend) return " missing";
  if (backend.ok) return backend.status ? ` status=${backend.status}` : "";
  return ` ${backend.error ?? backend.status ?? "not reachable"}`;
}

function printHints(hints) {
  if (hints.length === 0) return;
  console.log("");
  console.log("Recommended next steps:");
  for (const hint of hints) console.log(`- ${hint}`);
}

function printCodexSkills(codexSkills) {
  if (!codexSkills) return;
  console.log(`codex skills: ${codexSkillsStatusLine(codexSkills)}`);
  for (const skill of codexSkills.skills ?? []) {
    if (skill.status === "linked") continue;
    console.log(`  ${skill.name}: ${skillStatusLine(skill)}`);
  }
}

function codexSkillsStatusLine(codexSkills) {
  const counts = codexSkills.counts ?? {};
  const details = [
    `total=${counts.total ?? 0}`,
    `linked=${counts.linked ?? 0}`,
    counts.changed ? `changed=${counts.changed}` : undefined,
    counts.removed ? `removed=${counts.removed}` : undefined,
    counts.conflict ? `conflict=${counts.conflict}` : undefined,
    counts.sourceMissing ? `source-missing=${counts.sourceMissing}` : undefined,
    counts.failed ? `failed=${counts.failed}` : undefined,
  ].filter(Boolean).join(" ");
  return `${codexSkills.status ?? "unknown"}${details ? ` ${details}` : ""}`;
}

function statusHints(result) {
  const hints = [];
  if (result.codexSkills?.status === "missing") {
    hints.push("The plugin-managed memorax-code skill is missing; rerun `memorax-code start --codex-home DIR` to refresh the Codex plugin.");
  }
  if (result.enabled !== true) {
    hints.push("Enable the adapter after the Backend is installed: `memorax-code start`.");
  }
  if (result.state?.unreadable) {
    hints.push("Adapter state is unreadable; inspect or remove the state file, then rerun `memorax-code start`.");
  }
  if (result.backendUrlMatches === false) {
    hints.push("Adapter state points at a different Backend endpoint; rerun `memorax-code start` to reconcile the persisted Hook connection.");
  }
  return hints;
}

function doctorHints(result) {
  const hints = [...statusHints(result.status)];
  if (result.backend?.ok !== true) {
    hints.push("Backend is not reachable; start it with `memorax-code start` or pass the correct `--backend-url`.");
  }
  if (result.workspace?.captured !== true) {
    hints.push("No Codex workspace has been captured yet; open or restart Codex in a workspace with the MemoraX Code hook installed, then submit one prompt.");
  }
  return dedupe(hints);
}

function dedupe(values) {
  return [...new Set(values)];
}

function skillStatusLine(skill) {
  if (skill.status === "linked") return `ok linked source=${statusValue(skill.sourcePath)}`;
  if (skill.status === "plugin-managed") return "ok plugin-managed";
  if (skill.status === "missing") return `not linked target=${statusValue(skill.targetPath)}`;
  if (skill.status === "source-missing") return `not ok source missing at ${statusValue(skill.sourcePath)}`;
  if (skill.status === "conflict") return `not ok conflict target=${statusValue(skill.targetPath)}${skill.reason ? ` reason=${skill.reason}` : ""}`;
  if (skill.status === "link-failed") return `not ok link failed target=${statusValue(skill.targetPath)}${skill.reason ? ` reason=${skill.reason}` : ""}`;
  if (skill.status === "unlink-failed") return `not ok unlink failed target=${statusValue(skill.targetPath)}${skill.reason ? ` reason=${skill.reason}` : ""}`;
  return `not ok ${skill.status ?? "unknown"}`;
}

function statusValue(value) {
  return JSON.stringify(String(value ?? ""));
}

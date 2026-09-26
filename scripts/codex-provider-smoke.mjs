#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveWindowsCliInvocation } from "../packages/npm/memorax-code/lib/windows-cli-invocation.mjs";

const execFileAsync = promisify(execFile);
// Read this public setup script as data only; never execute its shell content.
const catalogUrl = "https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh";
const catalogSha256 = "bce20f679495809f4fa6e48672b6dcbab84b6adff5251890b6e6a21eddb9c12f";
const provider = "deepseek_connectivity";
const marker = "MEMORAX_CODE_PROVIDER_CONNECTIVITY_OK";
const expectedVersion = "codex-cli 0.147.0";
const report = {
  status: "FAIL", scope: "provider_connectivity_only", platform: process.platform,
  excludes: ["MemoraX plugin chain", "permission inheritance", "product functionality"],
  execInvocations: 0, httpRequestCount: "not_observed", timeoutMs: 120_000,
  requestRetries: 0, streamRetries: 0, hardOutputTokenLimit: "not_available",
};
let root, workspace, env;
let stage = "prerequisites";
try {
  check(process.argv.length === 3, "EXPECTED_CODEX_CLI_PATH");
  const command = resolve(process.argv[2]);
  const { LLM_BASE_URL: baseUrl, LLM_API_KEY: apiKey, LLM_MODEL: model } = process.env;
  check(baseUrl && apiKey && model, "MISSING_LLM_CONFIGURATION");
  const endpoint = new URL(baseUrl);
  check(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password
    && !endpoint.search && !endpoint.hash, "INVALID_PROVIDER_ENDPOINT");
  root = await mkdtemp(join(tmpdir(), "memorax-code-provider-"));
  const home = join(root, "user home");
  const codexHome = join(home, ".codex");
  workspace = join(root, "empty workspace");
  await Promise.all([codexHome, workspace, join(root, "tmp")].map((path) => mkdir(path, { recursive: true })));
  env = isolatedEnv(home, codexHome);
  stage = "CLI version";
  const version = await run(command, ["--version"], 15_000);
  check(version.stdout.trim() === expectedVersion, "UNEXPECTED_CODEX_VERSION");
  report.codexVersion = expectedVersion;

  stage = "official model catalog";
  const response = await fetch(catalogUrl, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  check(response.ok, "CATALOG_DOWNLOAD_FAILED");
  const setupText = await response.text();
  check(setupText.length < 1024 * 1024, "CATALOG_SOURCE_TOO_LARGE");
  const embedded = setupText.match(/<<'CODEX_MODELS_JSON'\r?\n([\s\S]*?)\r?\nCODEX_MODELS_JSON/);
  check(embedded, "CATALOG_NOT_FOUND_IN_OFFICIAL_SOURCE");
  const catalogBytes = Buffer.from(`${embedded[1]}\n`);
  check(createHash("sha256").update(catalogBytes).digest("hex") === catalogSha256, "CATALOG_HASH_MISMATCH");
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const matches = catalog.models?.filter((entry) => entry.slug === model);
  check(matches?.length === 1, "MODEL_NOT_IN_PINNED_OFFICIAL_CATALOG");
  check(matches[0].supported_reasoning_levels?.some((level) => level.effort === "low"), "MODEL_HAS_NO_LOW_REASONING");
  const catalogPath = join(codexHome, "models.json");
  await writeFile(catalogPath, JSON.stringify({ models: matches }), { mode: 0o600 });
  report.catalogSha256 = catalogSha256;
  const disabledFeatures = ["shell_tool", "unified_exec", "apply_patch_freeform", "view_image",
    "multi_agent", "apps", "plugins", "plugin_hooks", "hooks",
    "memories", "remote_models", "responses_websockets", "responses_websockets_v2",
    "shell_snapshot", "respect_system_proxy"];
  await writeFile(join(codexHome, "config.toml"), [
    `model = ${JSON.stringify(model)}`, `model_provider = "${provider}"`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`, 'model_reasoning_effort = "low"',
    'cli_auth_credentials_store = "file"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    'web_search = "disabled"', "project_doc_max_bytes = 0", "[shell_environment_policy]", 'inherit = "none"',
    "[features]", ...disabledFeatures.map((feature) => `${feature} = false`),
    `[model_providers.${provider}]`, 'name = "DeepSeek connectivity check"',
    `base_url = ${JSON.stringify(baseUrl)}`, 'wire_api = "responses"', 'env_key = "LLM_API_KEY"',
    "requires_openai_auth = false", "supports_websockets = false", "request_max_retries = 0",
    "stream_max_retries = 0", "stream_idle_timeout_ms = 30000", "",
  ].join("\n"), { mode: 0o600 });
  // Only the selected provider receives this key; no machine credentials are inherited.
  env.LLM_API_KEY = apiKey;
  const lastMessage = join(root, "last-message.txt");
  stage = "native Responses execution";
  report.execInvocations = 1;
  const result = await run(command, ["exec", "--strict-config", "--skip-git-repo-check", "--ignore-rules",
    "--json", "--color", "never", "--output-last-message", lastMessage,
    `Reply with exactly ${marker} and nothing else. Do not use any tools.`], 120_000);
  check(!result.stdout.includes(apiKey) && !result.stderr.includes(apiKey), "CREDENTIAL_IN_CLI_OUTPUT");
  stage = "native event verification";
  const events = jsonLines(result.stdout);
  report.codexExitCode = 0;
  const threads = events.filter((event) => event.type === "thread.started");
  const completed = events.filter((event) => event.type === "turn.completed");
  const items = events.filter((event) => ["item.started", "item.updated", "item.completed"].includes(event.type));
  report.nativeItemEventCounts = Object.create(null);
  for (const event of items) {
    const type = event.item?.type;
    const safeType = typeof type === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(type) ? type : "invalid_or_missing_type";
    const key = `${event.type}:${safeType}`;
    report.nativeItemEventCounts[key] = (report.nativeItemEventCounts[key] ?? 0) + 1;
  }
  report.nativeTurnCounts = { started: events.filter((event) => event.type === "turn.started").length,
    completed: completed.length };
  const usage = completed.length === 1 ? completed[0].usage : undefined;
  const validUsage = usage && ["input_tokens", "output_tokens", "cached_input_tokens"].every((key) =>
    Number.isSafeInteger(usage[key]) && usage[key] >= 0) && usage.input_tokens > 0 && usage.output_tokens > 0;
  report.usage = validUsage ? Object.fromEntries(["input_tokens", "cached_input_tokens", "cache_write_input_tokens",
    "output_tokens", "reasoning_output_tokens"].filter((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    .map((key) => [key, usage[key]])) : "unavailable_or_invalid";
  const allowedEvents = new Set(["thread.started", "turn.started", "turn.completed",
    "item.started", "item.updated", "item.completed"]);
  check(events.every((event) => allowedEvents.has(event.type)), "UNEXPECTED_OR_FAILED_NATIVE_EVENT");
  check(threads.length === 1 && typeof threads[0].thread_id === "string"
    && report.nativeTurnCounts.started === 1
    && completed.length === 1, "EXPECTED_ONE_NATIVE_TURN");
  check(items.every((event) => ["agent_message", "reasoning"].includes(event.item?.type)), "TOOL_OR_UNKNOWN_ITEM_OBSERVED");
  const messages = items.filter((event) => event.type === "item.completed" && event.item.type === "agent_message");
  check(messages.length === 1 && messages[0].item.text.trim() === marker
    && (await readFile(lastMessage, "utf8")).trim() === marker, "FIXED_MARKER_MISMATCH");
  check(validUsage, "MISSING_OR_INVALID_NATIVE_USAGE");

  stage = "selected provider and model verification";
  const rollouts = (await readdir(join(codexHome, "sessions"), { recursive: true }))
    .filter((path) => /(?:^|[/\\])rollout-[^/\\]+\.jsonl$/.test(path));
  check(rollouts.length === 1, "EXPECTED_ONE_NATIVE_ROLLOUT");
  const records = jsonLines(await readFile(join(codexHome, "sessions", rollouts[0]), "utf8"));
  const metadata = records.filter((record) => record.type === "session_meta");
  const turns = records.filter((record) => record.type === "turn_context");
  check(metadata.length === 1 && metadata[0].payload?.id === threads[0].thread_id
    && metadata[0].payload.model_provider === provider
    && metadata[0].payload.cli_version === "0.147.0", "ROLLOUT_PROVIDER_MISMATCH");
  check(turns.length >= 1 && turns.every((record) => record.payload?.model === model
    && resolve(record.payload.cwd) === workspace), "ROLLOUT_MODEL_OR_WORKSPACE_MISMATCH");
  check(records.filter((record) => record.type === "response_item")
    .every((record) => ["message", "reasoning"].includes(record.payload?.type)), "TOOL_OR_UNKNOWN_ROLLOUT_RESPONSE");
  check((await readdir(workspace)).length === 0, "WORKSPACE_WAS_MODIFIED");
  Object.assign(report, { status: "PASS", selectedProvider: provider, selectedModel: model,
    completedTurns: 1, observedToolCalls: 0, markerMatched: true, nativeRolloutMatched: true });
} catch (error) {
  report.stage = stage;
  report.error = error.smokeCode ?? "STAGE_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  if (Number.isInteger(error.code)) report.exitCode = error.code;
  const httpStatus = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(
    /(?:HTTP(?:\/[0-9.]+)?|status(?: code)?)\s*[:=]?\s*(400|401|403|404|408|409|422|429|500|502|503|504)\b/i);
  if (httpStatus) report.httpStatusFromCliOutput = Number(httpStatus[1]);
} finally {
  if (env) delete env.LLM_API_KEY;
  try {
    if (root) await rm(root, { recursive: true, force: true });
    report.cleanup = "PASS";
  } catch { report.status = "FAIL"; report.cleanup = "FAILED_TO_REMOVE_PRIVATE_TEMPORARY_STATE"; }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { smokeCode: code });
}
function jsonLines(value) { return value.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)); }

async function run(command, args, timeout) {
  const invocation = resolveWindowsCliInvocation(command, args, { env });
  const pending = execFileAsync(invocation.command, invocation.args, {
    cwd: workspace, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    windowsHide: true, detached: process.platform !== "win32",
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end();
  let timedOut = false;
  let stopping;
  const timer = setTimeout(() => { timedOut = true; stopping = stopTree(pending.child); }, timeout);
  try {
    const result = await pending;
    check(!timedOut, "CODEX_PROCESS_TIMEOUT");
    return result;
  } catch (error) {
    stopping ??= stopTree(pending.child);
    check(!timedOut, "CODEX_PROCESS_TIMEOUT");
    throw error;
  } finally { clearTimeout(timer); if (stopping) await stopping; }
}

async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await execFileAsync(join(env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
      { env, windowsHide: true, timeout: 10_000 }).catch(() => { child.kill(); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

function isolatedEnv(home, codexHome) {
  const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemPaths = process.platform === "win32" ? [join(windowsRoot, "System32"), windowsRoot] : ["/usr/bin", "/bin"];
  const isolated = {
    HOME: home, USERPROFILE: home, USER: "provider-smoke", LOGNAME: "provider-smoke", LANG: "en_US.UTF-8",
    PATH: [dirname(process.execPath), ...systemPaths].join(delimiter), CODEX_HOME: codexHome,
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
  };
  if (process.platform === "win32") Object.assign(isolated, {
    SystemRoot: windowsRoot, WINDIR: windowsRoot, ComSpec: join(windowsRoot, "System32", "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD", USERNAME: "provider-smoke",
  });
  return isolated;
}

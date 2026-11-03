import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export const USER_PROMPT = "Reply with the compatibility fixture response.";
export const VISIBLE_REPLY = "DSH_DESKTOP_COMPAT_REPLY";
export const MEMORAX_KEY = "sk_" + "E".repeat(43);
export const MODEL_KEY = "synthetic-dsh-desktop-native-key";

export function parseArguments(args) {
  const result = {};
  const names = new Map([["--desktop-command", "desktopCommand"], ["--tarball", "tarball"], ["--artifacts-dir", "artifactsDir"]]);
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]);
    const value = args[index + 1];
    assert.ok(name && !Object.hasOwn(result, name) && typeof value === "string"
      && isAbsolute(value) && !/[\r\n\0]/.test(value), "expected unique options with absolute paths");
    result[name] = resolve(value);
  }
  assert.ok(result.desktopCommand && result.tarball, "--desktop-command and --tarball are required");
  return result;
}

export async function resolveDesktopLauncher(command, platform = process.platform) {
  assert.equal(platform, "darwin", "this check supports the macOS Desktop carrier only");
  const launcher = await realpath(command);
  const suffix = join("Contents", "Resources", "runtime", "cli", "bin", "dsh");
  assert.ok(launcher.endsWith(sep + suffix), "expected the official app's bundled runtime/cli/bin/dsh launcher");
  const appBundle = launcher.slice(0, -suffix.length - 1);
  assert.ok(appBundle.endsWith(".app"), "expected a macOS .app bundle");
  const resources = join(appBundle, "Contents", "Resources");
  const electron = join(appBundle, "Contents", "MacOS", "DeepSeek Harness");
  const asar = join(resources, "app.asar");
  const source = await readFile(launcher, "utf8");
  assert.ok(source.includes("ELECTRON_RUN_AS_NODE=1") && source.includes("dsh-desktop-host/lib/cli.js"),
    "launcher does not select the official Desktop CLI host");
  await Promise.all([access(launcher, constants.X_OK), access(electron, constants.X_OK)]);
  assert.ok((await stat(asar)).isFile(), "Desktop app.asar is missing");
  return { launcher, appBundle, electron, runtimeDir: join(asar, "dsh") };
}

export function isolatedPaths(root) {
  assert.ok(isAbsolute(root) && root !== parse(root).root && !/[\r\n\0]/.test(root), "expected an isolated absolute root");
  return Object.fromEntries(["home", "state", "dsh", "workspace", "prefix", "bin", "cache", "tmp", "logs"]
    .map((name) => [name, join(root, name)]));
}

export function isolatedEnvironment(paths, desktopCommand) {
  const env = {
    PATH: [paths.bin, join(paths.prefix, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    HOME: paths.home, USERPROFILE: paths.home, CFFIXED_USER_HOME: paths.home, ZDOTDIR: paths.home,
    MEMORAX_CODE_HOME: paths.state, DSH_HOME: paths.dsh,
    TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp, LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: join(paths.home, ".config"), XDG_CACHE_HOME: join(paths.home, ".cache"),
    XDG_DATA_HOME: join(paths.home, ".local", "share"), XDG_STATE_HOME: join(paths.home, ".local", "state"),
    NPM_CONFIG_PREFIX: paths.prefix, NPM_CONFIG_CACHE: paths.cache,
    NPM_CONFIG_USERCONFIG: join(paths.home, ".npmrc"), NPM_CONFIG_GLOBALCONFIG: join(paths.home, "global-npmrc"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT: "false",
    MEMORAX_CODE_DSH_DESKTOP_COMMAND: desktopCommand,
    MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_JEV_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true", MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false", MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE: "en",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", DSH_TELEMETRY_DISABLED: "1", DSH_PERMISSION_MODE: "danger-full-access",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "OPENCODE_CONFIG_DIR", "CODEBUDDY_HOME",
    "WORKBUDDY_HOME", "TRAE_CN_HOME", "TRAE_HOME", "CURSOR_HOME"]) env[name] = join(paths.home, name.toLowerCase());
  for (const client of ["CODEX", "CLAUDE", "OPENCODE", "CODEBUDDY", "WORKBUDDY"]) {
    env[`MEMORAX_CODE_${client}_COMMAND`] = "/usr/bin/false";
  }
  env.MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL = "1";
  for (const client of ["CLAUDE", "OPENCODE", "CODEBUDDY", "WORKBUDDY", "TRAE", "CURSOR"]) {
    env[`MEMORAX_CODE_SKIP_${client}_ADAPTER_INSTALL`] = "1";
  }
  return env;
}

export async function findNpm(nodePath = process.execPath, path = process.env.PATH ?? "") {
  for (const directory of [dirname(nodePath), ...path.split(delimiter)]) {
    if (!directory) continue;
    const candidate = join(directory, "npm");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Try the next explicit npm command source. */ }
  }
  throw new Error("npm is required to install the supplied tarball and matching official mock package");
}

export function redactOutput(text) {
  return text.replaceAll(MEMORAX_KEY, "[synthetic-key]").replaceAll(MODEL_KEY, "[synthetic-key]")
    .replace(/([?&]token=)[^\s&"']+/g, "$1[redacted]");
}

export async function runProcess(command, args, { cwd, env, logPath, input = "", timeout = 120_000, signal }) {
  assert.ok(!signal?.aborted, "native check was interrupted");
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false, aborted = false, hardStop;
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-2 * 1024 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2 * 1024 * 1024); });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const terminate = () => {
    signalOwnedProcessGroup(child.pid, "SIGTERM");
    hardStop ??= setTimeout(() => signalOwnedProcessGroup(child.pid, "SIGKILL"), 2_000);
    hardStop.unref();
  };
  const interrupted = () => { aborted = true; terminate(); };
  signal?.addEventListener("abort", interrupted, { once: true });
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
  let result;
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    result = { code, timedOut, aborted, stdout: redactOutput(stdout), stderr: redactOutput(stderr) };
    if (logPath) await writeFile(logPath, JSON.stringify(result, null, 2) + "\n");
    assert.equal(timedOut, false, "native check stage timed out");
    assert.equal(aborted, false, "native check was interrupted");
    assert.equal(code, 0, `native check stage failed; see ${logPath ?? "captured output"}`);
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(hardStop);
    signal?.removeEventListener("abort", interrupted);
    if (timedOut || aborted) signalOwnedProcessGroup(child.pid, "SIGKILL");
  }
}

function signalOwnedProcessGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

export async function cleanupAll(tasks) {
  const failures = [];
  for (const task of tasks) {
    try { await task(); } catch (error) { failures.push(error); }
  }
  return failures;
}

export function assertCleanWriteback(requests, sessionId) {
  const adds = requests.filter((request) => request.path === "/v1/memories/add");
  assert.equal(adds.length, 1, "exactly one automatic Add is expected");
  assert.equal(adds[0].body.session_id, sessionId);
  assert.deepEqual(adds[0].body.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: USER_PROMPT }, { role: "assistant", content: VISIBLE_REPLY },
  ], "automatic Add must contain only the native user and visible assistant messages");
}

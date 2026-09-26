#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const pluginName = "memorax-code-codex-adapter";
const pluginId = `${pluginName}@memorax-code`;
const otherClients = ["claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"];
const fixtureKey = `sk_${"E".repeat(43)}`;
const report = { status: "FAIL", platform: process.platform, arch: process.arch, checks: [] };
let stage = "prerequisites";
let root, env, workspace, entrypoint, stateHome, codexHome, backendPort, endpoint;
let resolveInvocation;
let setupStarted = false;
let requests = 0;
const backendPids = new Set();

try {
  check(["darwin", "linux", "win32"].includes(process.platform), "This smoke test requires macOS, Linux or Windows");
  check(process.argv.length === 4, "Usage: codex-install-smoke.mjs INSTALLED_PACKAGE_ROOT CODEX_CLI_PATH");
  const packageRoot = resolve(process.argv[2]);
  const codexCommand = resolve(process.argv[3]);
  entrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  ({ resolveWindowsCliInvocation: resolveInvocation } = await import(
    pathToFileURL(join(packageRoot, "lib", "windows-cli-invocation.mjs")).href));
  const manifest = await readJson(join(packageRoot, "package.json"));
  check(manifest.name === "@memorax/memorax-code", "The installed package has an unexpected identity");
  const sourceRoot = join(packageRoot, "lib", pluginName);
  const pluginManifest = await readJson(join(sourceRoot, ".codex-plugin", "plugin.json"));
  const hookManifest = await readJson(join(sourceRoot, "hooks", "hooks.json"));
  const expectedEvents = Object.entries(hookManifest.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map(() => event[0].toLowerCase() + event.slice(1)))).sort();
  const { parse } = createRequire(join(packageRoot, "package.json"))("smol-toml");
  report.packageVersion = manifest.version;
  report.pluginVersion = pluginManifest.version;

  root = await mkdtemp(join(tmpdir(), "memorax-code-codex-install-"));
  const userHome = join(root, "user home");
  workspace = join(root, "workspace");
  stateHome = join(userHome, ".memorax-code");
  codexHome = join(userHome, ".codex");
  await Promise.all([workspace, stateHome, codexHome, join(root, "tmp")].map((path) => mkdir(path, { recursive: true })));
  backendPort = await freePort();
  endpoint = createServer((_request, response) => {
    requests += 1;
    response.writeHead(503).end();
  });
  await new Promise((done, reject) => { endpoint.once("error", reject); endpoint.listen(0, "127.0.0.1", done); });
  const dummyUrl = `http://127.0.0.1:${endpoint.address().port}`;
  env = isolatedEnv(userHome, codexCommand, dummyUrl);
  await writeFile(join(stateHome, "config.toml"), ["[clients]", "codex = true",
    ...otherClients.map((client) => `${client} = false`), ""].join("\n"), { mode: 0o600 });
  const originalProvider = { model: "install-smoke", model_provider: "install-smoke", model_providers: {
    "install-smoke": { name: "Install smoke", base_url: dummyUrl, wire_api: "responses" },
  } };
  await writeFile(join(codexHome, "config.toml"), [
    'model = "install-smoke"', 'model_provider = "install-smoke"',
    '[model_providers.install-smoke]', 'name = "Install smoke"',
    `base_url = "${dummyUrl}"`, 'wire_api = "responses"', "",
  ].join("\n"), { mode: 0o600 });
  const version = await run(codexCommand, ["--version"]);
  check(/^codex-cli \S+$/.test(version.stdout.trim()), "The Codex command did not return its version");
  report.codexVersion = version.stdout.trim();
  report.checks.push("installed package and real Codex CLI available");

  let firstRegistration;
  for (const attempt of ["first", "repeat"]) {
    stage = `${attempt} setup`;
    setupStarted = true;
    await product(["setup", "--existing-account", "--non-interactive"], `${fixtureKey}\n`);
    stage = `${attempt} native registration`;
    const native = JSON.parse((await run(codexCommand, ["plugin", "list", "--available", "--json"])).stdout);
    check(Array.isArray(native.installed), "Codex did not return an installed plugin list");
    const matches = native.installed.filter((item) => item.name === pluginName || item.pluginId === pluginId);
    check(matches.length === 1, "Codex must register exactly one MemoraX Code plugin");
    const registration = matches[0];
    check(registration.pluginId === pluginId && registration.installed === true && registration.enabled === true,
      "The native plugin registration is missing, disabled, or has an unexpected identity");
    check(registration.version === pluginManifest.version, "The native plugin version differs from the installed package");
    if (firstRegistration) check(registration.pluginId === firstRegistration.pluginId
      && registration.version === firstRegistration.version, "Repeated setup changed plugin identity or version");
    firstRegistration = registration;

    stage = `${attempt} native hooks`;
    const hooks = await productJson(["codex-plugin", "hooks", "--json"]);
    check(hooks.ok === true && Array.isArray(hooks.hooks), "Codex did not return plugin Hooks");
    check(JSON.stringify(hooks.hooks.map((hook) => hook.eventName).sort()) === JSON.stringify(expectedEvents),
      "Native Hook events differ from the installed Hook manifest");
    check(hooks.hooks.every((hook) => hook.pluginId === pluginId
      && ["trusted", "managed"].includes(hook.trustStatus)), "Some native plugin Hooks are not trusted");
    const trust = await productJson(["codex-plugin", "trust-hooks", "--check", "--json"]);
    check(trust.ok === true && trust.checkedOnly === true && trust.hooks.length === 0
      && trust.requiresFullReview === false, "Hook trust still requires review after setup");

    stage = `${attempt} readiness`;
    const completion = await readJson(join(stateHome, "runtime", "setup", "setup-completion.json"));
    check(completion.version === 1 && completion.state === "complete"
      && completion.completedByVersion === manifest.version, "Setup did not record completion for this package");
    const status = await productJson(["status", "--clients", "codex", "--json"]);
    check(status.ok === true && status.backend?.ok === true, "The installed Backend is not healthy");
    check(status.codexAdapter?.ok === true && status.codexAdapter.enabled === true
      && status.codexAdapter.backendUrlMatches === true, "The Codex adapter is not connected to this Backend");
    const skill = status.codexAdapter.codexSkills;
    check(skill?.ok === true && skill.delivery === "plugin" && typeof skill.rootPath === "string",
      "The Codex adapter does not expose its packaged Skill");
    const skillRelative = relative(codexHome, skill.rootPath);
    check(skillRelative !== ".." && !skillRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(skillRelative), "The installed Skill escaped the isolated Codex home");
    const installedSkill = await readFile(join(skill.rootPath, "memorax-code", "SKILL.md"), "utf8");
    check(installedSkill === await readFile(join(sourceRoot, "skills", "memorax-code", "SKILL.md"), "utf8"),
      "The installed Skill differs from the packaged Skill");
    const config = parse(await readFile(join(codexHome, "config.toml"), "utf8"));
    check(config.model === originalProvider.model && config.model_provider === originalProvider.model_provider
      && JSON.stringify(config.model_providers) === JSON.stringify(originalProvider.model_providers),
    "Setup changed the existing Codex model configuration");
    const backend = await readJson(join(stateHome, "runtime", "backend", "backend.pid.json"));
    check(Number.isInteger(backend.pid) && backend.pid > 0, "Backend PID record is invalid");
    backendPids.add(backend.pid);
    report.checks.push(`${attempt} setup: native plugin, trusted Hooks, packaged Skill, Backend and completion verified`);
  }
  stage = "outbound isolation";
  check(requests === 0, "Installation unexpectedly contacted the model or MemoraX endpoint");
  report.checks.push("no model or MemoraX requests");
  report.status = "PASS";
} catch (error) {
  report.stage = stage;
  report.error = error.smokeMessage ?? "The stage failed; private command output was suppressed";
  if (typeof error.code === "number") report.exitCode = error.code;
  if (error.diagnosticCode) report.diagnosticCode = error.diagnosticCode;
} finally {
  try {
    if (setupStarted) {
      const pidPath = join(stateHome, "runtime", "backend", "backend.pid.json");
      const backend = await readJson(pidPath).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (Number.isInteger(backend?.pid) && backend.pid > 0) backendPids.add(backend.pid);
      const stopped = await productJson(["stop", "--clients", "codex", "--json"]);
      check(stopped.ok === true, "Backend stop did not succeed");
      check(await stat(pidPath).then(() => false, (error) => { if (error.code === "ENOENT") return true; throw error; }),
        "Backend PID record remains after stop");
      for (const pid of backendPids) {
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
        check(!alive, "An installation Backend process remains after stop");
      }
      const probe = createTcpServer();
      await new Promise((done, reject) => { probe.once("error", reject); probe.listen(backendPort, "127.0.0.1", done); });
      await new Promise((done) => probe.close(done));
      report.checks.push("Backend stopped, process exited and port released");
    }
    if (root) await rm(root, { recursive: true, force: true });
    report.cleanup = "PASS";
  } catch {
    report.status = "FAIL";
    report.cleanup = "FAIL: isolated state retained because shutdown was not confirmed";
  }
  if (endpoint?.listening) {
    endpoint.closeAllConnections();
    await new Promise((done) => endpoint.close(done));
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { smokeMessage: message });
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

async function run(command, args, input = "") {
  const invocation = resolveInvocation(command, args, { env });
  const pending = execFileAsync(invocation.command, invocation.args, {
    cwd: workspace, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true,
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(input);
  let result;
  try { result = await pending; }
  catch (error) {
    // Report only the stable product error code, never raw process output.
    error.diagnosticCode = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(/\b(?:CLIENT|CODEX|BACKEND|SETUP|CONFIG)_[A-Z_]{3,}\b/)?.[0];
    throw error;
  }
  check(!`${result.stdout}\n${result.stderr}`.includes(fixtureKey), "A command disclosed the setup credential");
  return result;
}

function product(args, input) { return run(process.execPath, [entrypoint, ...args], input); }
async function productJson(args) { return JSON.parse((await product(args)).stdout); }

async function freePort() {
  const server = createTcpServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function isolatedEnv(userHome, codexCommand, dummyUrl) {
  const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemPaths = process.platform === "win32"
    ? [join(windowsRoot, "System32"), windowsRoot, join(windowsRoot, "System32", "Wbem"),
      join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/usr/bin", "/bin"];
  const isolated = {
    HOME: userHome, USERPROFILE: userHome, USER: "install-smoke", LOGNAME: "install-smoke", LANG: "en_US.UTF-8",
    PATH: [dirname(process.execPath), ...systemPaths].join(delimiter),
    APPDATA: join(userHome, "AppData", "Roaming"), LOCALAPPDATA: join(userHome, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(userHome, ".config"), XDG_DATA_HOME: join(userHome, ".local", "share"),
    XDG_STATE_HOME: join(userHome, ".local", "state"), XDG_CACHE_HOME: join(userHome, ".cache"),
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(backendPort),
    MEMORAX_CODE_MEMORAX_ENDPOINT: dummyUrl, MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED: "false",
    CODEX_HOME: codexHome, CODEX_CLI_PATH: codexCommand, MEMORAX_CODE_CODEX_COMMAND: codexCommand,
    DSH_HOME: join(userHome, ".dsh"), CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CLAUDE_HOME: join(userHome, ".claude"),
    OPENCODE_CONFIG_DIR: join(userHome, ".config", "opencode"),
    CODEBUDDY_HOME: join(userHome, ".codebuddy"), CODEBUDDY_CONFIG_DIR: join(userHome, ".codebuddy"),
    WORKBUDDY_HOME: join(userHome, ".workbuddy"), WORKBUDDY_CONFIG_DIR: join(userHome, ".workbuddy"),
    TRAE_CN_HOME: join(userHome, ".trae-cn"), TRAE_HOME: join(userHome, ".trae-cn"), CURSOR_HOME: join(userHome, ".cursor"),
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  };
  if (process.platform === "win32") Object.assign(isolated, {
    SystemRoot: windowsRoot, WINDIR: windowsRoot,
    ComSpec: join(windowsRoot, "System32", "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD", USERNAME: "install-smoke",
  });
  for (const client of otherClients) {
    isolated[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`] = join(root, "unused-client");
    isolated[`MEMORAX_CODE_${client.toUpperCase()}_TRACE_ENABLED`] = "false";
    isolated[`MEMORAX_CODE_SKIP_${client.toUpperCase()}_ADAPTER_INSTALL`] = "1";
  }
  return isolated;
}

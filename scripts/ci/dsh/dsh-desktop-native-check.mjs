#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MEMORAX_KEY, MODEL_KEY, VISIBLE_REPLY, assertCleanWriteback, cleanupAll, findNpm,
  isolatedEnvironment, isolatedPaths, parseArguments, resolveDesktopLauncher, runProcess,
} from "./dsh-desktop-native-support.mjs";

const usage = `Usage:
  node scripts/ci/dsh/dsh-desktop-native-check.mjs \\
    --desktop-command "/absolute/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \\
    --tarball /absolute/memorax-code.tgz [--artifacts-dir /absolute/outside-repository]

macOS only. Uses the supplied official Desktop app and a local MemoraX tarball.
Installs the same-version official DSH mock package into a temporary npm prefix.
Checks the reserved Desktop profile in Electron's Node runtime with local mocks.
Does not download Desktop, open its GUI, or contact a real model/memory service.
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(usage);
} else {
  main().catch((error) => {
    console.error(`dsh_desktop_native_check_failed: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const desktop = await resolveDesktopLauncher(options.desktopCommand);
  const tarball = await realpath(options.tarball);
  assert.ok((await stat(tarball)).isFile(), "tarball must be a file");
  const npm = await findNpm();
  const artifactsParent = await realpath(options.artifactsDir ?? tmpdir());
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repository = await realpath(resolve(scriptDirectory, "../../.."));
  const underRepository = relative(repository, artifactsParent);
  assert.ok(underRepository.startsWith(".." + sep) || underRepository === "..", "artifacts must be outside the repository");
  const root = await realpath(await mkdtemp(join(artifactsParent, "memorax-dsh-desktop-")));
  const paths = isolatedPaths(root);
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  // Only these two commands are projected into the test's PATH. Installed real
  // clients and ambient shell startup files cannot influence client discovery.
  await symlink(process.execPath, join(paths.bin, "node"));
  await symlink(npm, join(paths.bin, "npm"));
  const env = isolatedEnvironment(paths, desktop.launcher);
  const runner = join(scriptDirectory, "fixtures", "desktop-runtime-runner.mjs");
  const fence = pathToFileURL(join(scriptDirectory, "fixtures", "local-network-only.mjs")).href;
  const report = { validationSurface: "macOS Desktop profile and Electron Node runtime; GUI not exercised", stages: [],
    tarballSha256: createHash("sha256").update(await readFile(tarball)).digest("hex") };
  let entry, memory, model, failure, completedSessionId;
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const memoryRequests = [];
  const stage = async (name, command, args, extra = {}) => {
    process.stdout.write(`dsh_desktop_native_check: ${name}\n`);
    const result = await runProcess(command, args, { cwd: paths.workspace, env, signal: cancellation.signal,
      logPath: join(paths.logs, name + ".json"), ...extra });
    report.stages.push({ name, code: result.code });
    return result;
  };
  try {
    const version = (await stage("desktop-version", desktop.launcher, ["--version"])).stdout.trim();
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Desktop must report an exact release version");
    report.dshVersion = version;
    env.DSH_CLIENT_VERSION = version;
    await stage("initialize-desktop", desktop.electron,
      ["--expose-internals", "--import", fence, runner, "init", desktop.runtimeDir, join(root, "profile-init.json")],
      { env: { ...env, ELECTRON_RUN_AS_NODE: "1" } });
    await writeFile(join(paths.state, "config.toml"), ["[clients]",
      ...["codex", "claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"].map((client) => `${client} = ${client === "dsh"}`),
      "[jev]", "enabled = false", ""].join("\n"));
    await stage("install-packages", npm, ["install", "-g", "--prefix", paths.prefix, tarball,
      `@deepseek-ai/dsh-llm-mock-server@${version}`, "--omit=optional", "--foreground-scripts", "--loglevel", "warn"], { timeout: 180_000 });
    const packages = join(paths.prefix, "lib", "node_modules");
    entry = join(packages, "@memorax", "memorax-code", "bin", "memorax-code.mjs");
    const mockModule = await import(pathToFileURL(join(packages, "@deepseek-ai", "dsh-llm-mock-server", "lib", "index.js")));
    model = await mockModule.startMockLlmServer({ sequence: ["success"], repeatLast: true, apiKey: MODEL_KEY, successText: VISIBLE_REPLY });
    memory = await startMemoryMock(memoryRequests);
    Object.assign(env, {
      MEMORAX_CODE_BACKEND_PORT: String(await freePort()),
      MEMORAX_CODE_MEMORAX_ENDPOINT: memory.baseUrl,
      MEMORAX_CODE_MEMORAX_API_KEY: MEMORAX_KEY, MEMORAX_CODE_MEMORAX_USER_ID: "dsh-desktop-native-fixture",
      DEEPSEEK_BASE_URL: model.baseURL + "/v1", DEEPSEEK_API_KEY: MODEL_KEY,
      DSH_PRODUCT_ANALYTICS_OTLP_URL: memory.baseUrl + "/telemetry",
    });
    await stage("setup", process.execPath, [entry, "setup", "--existing-account", "--non-interactive", "--home", paths.state],
      { input: MEMORAX_KEY + "\n", timeout: 180_000 });
    const status = JSON.parse((await stage("status", process.execPath, [entry, "status", "--clients", "dsh", "--json"])).stdout);
    assert.equal(status.dshAdapter?.enabled, true);
    assert.ok(status.dshAdapter.profiles.some((profile) => profile.name === "desktop" && profile.installed));
    await stage("native-desktop-turn", desktop.electron,
      ["--expose-internals", "--import", fence, runner, "turn", desktop.runtimeDir, join(root, "runtime.json")],
      { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 90_000 });
    const runtime = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
    assert.equal(runtime.ok, true);
    assert.equal(runtime.profileName, "desktop");
    const deadline = Date.now() + 10_000;
    while (!memoryRequests.some((request) => request.path === "/v1/memories/add") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assertCleanWriteback(memoryRequests, runtime.sessionId);
    completedSessionId = runtime.sessionId;
    assert.ok(model.requests.some((request) => JSON.stringify(request.body).includes("MemoraX Code reminder:")),
      "model input must include the installed MemoraX reminder");
    report.runtime = { electron: runtime.electron, node: runtime.node, profileName: runtime.profileName,
      sessionVersion: runtime.sessionVersion, replyObserved: runtime.replyObserved, memoraxEntries: runtime.memoraxEntries,
      reminderSources: runtime.reminderSources, completedTurns: runtime.turnEnds.length };
    report.modelRequests = model.requests.length;
    report.automaticAdds = 1;
    report.writebackContainsOnlyNativeQa = true;
  } catch (error) {
    failure = error;
  } finally {
    const cleanupFailures = await cleanupAll([
      async () => {
        if (!entry) return;
        const stopped = JSON.parse((await stage("stop", process.execPath, [entry, "stop", "--clients", "dsh", "--json"],
          { timeout: 90_000, signal: undefined })).stdout);
        assert.equal(stopped.ok, true, "Backend and Desktop adapter cleanup must succeed");
      },
      async () => { await model?.close(); },
      async () => { await memory?.close(); },
      async () => {
        if (!completedSessionId) return;
        // Check again after shutdown so a late duplicate Add cannot pass.
        assertCleanWriteback(memoryRequests, completedSessionId);
        report.automaticAdds = memoryRequests.filter((request) => request.path === "/v1/memories/add").length;
      },
    ]);
    report.ok = !failure && cleanupFailures.length === 0;
    if (failure) report.error = failure.message;
    if (cleanupFailures.length) report.cleanupErrors = cleanupFailures.map((error) => error.message);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(`dsh_desktop_native_check: ${report.ok ? "PASS" : "FAIL"}; report=${join(root, "report.json")}\n`);
    if (failure || cleanupFailures.length) throw new AggregateError([failure, ...cleanupFailures].filter(Boolean), "Desktop native check or cleanup failed");
  }
}

async function startMemoryMock(requests) {
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.url !== "/telemetry") requests.push({ path: request.url, body: body ? JSON.parse(body) : undefined });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/telemetry" ? {} : { success: true, data: { task_id: "desktop-fixture", status: "accepted", data: null } }));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

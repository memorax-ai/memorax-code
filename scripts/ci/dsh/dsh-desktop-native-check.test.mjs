import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MEMORAX_KEY, MODEL_KEY, USER_PROMPT, VISIBLE_REPLY, assertCleanWriteback, cleanupAll,
  isolatedEnvironment, isolatedPaths, parseArguments, redactOutput, resolveDesktopLauncher, runProcess,
} from "./dsh-desktop-native-support.mjs";

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktop-check-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("native check requires explicit unique absolute Desktop and tarball arguments", () => {
  const desktopCommand = resolve(tmpdir(), "DeepSeek Harness.app/dsh");
  const tarball = resolve(tmpdir(), "package.tgz");
  assert.deepEqual(parseArguments(["--desktop-command", desktopCommand, "--tarball", tarball]), { desktopCommand, tarball });
  for (const args of [[], ["--tarball", "/tmp/package.tgz"], ["--desktop-command", "relative"],
    ["--unknown", "/tmp/x"], ["--desktop-command", "/tmp/dsh", "--tarball"],
    ["--desktop-command", "/tmp/dsh", "--tarball", "/tmp/a", "--tarball", "/tmp/b"],
    ["--desktop-command", "/tmp/dsh\ncommand", "--tarball", "/tmp/a"]]) assert.throws(() => parseArguments(args));
});

test("Desktop resolution follows a launcher symlink into the complete official macOS layout", async (t) => {
  const root = await temporaryRoot(t);
  const bundle = join(root, "DeepSeek Harness.app");
  const launcher = join(bundle, "Contents/Resources/runtime/cli/bin/dsh");
  const electron = join(bundle, "Contents/MacOS/DeepSeek Harness");
  await Promise.all([mkdir(dirname(launcher), { recursive: true }), mkdir(dirname(electron), { recursive: true })]);
  await writeFile(launcher, "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec electron dsh-desktop-host/lib/cli.js\n");
  await writeFile(electron, "#!/bin/sh\nexit 0\n");
  await Promise.all([chmod(launcher, 0o755), chmod(electron, 0o755)]);
  await writeFile(join(bundle, "Contents/Resources/app.asar"), "fixture");
  const linked = join(root, "dsh");
  await symlink(launcher, linked);
  const result = await resolveDesktopLauncher(linked, "darwin");
  assert.ok(result.launcher.endsWith(join("DeepSeek Harness.app", "Contents/Resources/runtime/cli/bin/dsh")));
  assert.equal(result.runtimeDir, join(dirname(dirname(dirname(dirname(result.launcher)))), "app.asar/dsh"));
  await assert.rejects(resolveDesktopLauncher(linked, "linux"), /macOS/);
  await writeFile(launcher, "#!/bin/sh\nexec unrelated-client\n");
  await assert.rejects(resolveDesktopLauncher(linked, "darwin"), /official Desktop CLI/);
});

test("isolated runtime omits ambient authority and isolates client homes and command discovery", () => {
  const paths = isolatedPaths(resolve(tmpdir(), "desktop isolated fixture"));
  const env = isolatedEnvironment(paths, "/tmp/app/Contents/Resources/runtime/cli/bin/dsh");
  for (const key of ["NODE_OPTIONS", "SSH_AUTH_SOCK", "HTTP_PROXY", "HTTPS_PROXY", "DEEPSEEK_API_KEY",
    "MEMORAX_CODE_MEMORAX_API_KEY", "MEMORAX_CODE_DSH_COMMAND"]) assert.equal(env[key], undefined);
  assert.equal(env.HOME, paths.home);
  assert.equal(env.CFFIXED_USER_HOME, paths.home);
  assert.equal(env.MEMORAX_CODE_HOME, paths.state);
  assert.equal(env.DSH_HOME, paths.dsh);
  for (const client of ["CODEX", "CLAUDE", "OPENCODE", "CODEBUDDY", "WORKBUDDY"]) {
    assert.equal(env[`MEMORAX_CODE_${client}_COMMAND`], "/usr/bin/false");
  }
  assert.equal(env.MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL, "1");
  for (const client of ["CLAUDE", "OPENCODE", "CODEBUDDY", "WORKBUDDY", "TRAE", "CURSOR"]) {
    assert.equal(env[`MEMORAX_CODE_SKIP_${client}_ADAPTER_INSTALL`], "1");
  }
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "OPENCODE_CONFIG_DIR", "CODEBUDDY_HOME",
    "WORKBUDDY_HOME", "TRAE_CN_HOME", "TRAE_HOME", "CURSOR_HOME"]) assert.ok(env[key].startsWith(paths.home + sep), key);
  assert.equal(env.PATH, [paths.bin, join(paths.prefix, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter));
  for (const root of [parse(paths.home).root, "relative", "/tmp/invalid\npath"]) assert.throws(() => isolatedPaths(root));
});

test("cleanup continues to close both local servers when Backend stop fails", async () => {
  const calls = [];
  const failure = new Error("stop failed");
  const failures = await cleanupAll([
    async () => { calls.push("stop"); throw failure; },
    async () => { calls.push("model"); },
    async () => { calls.push("memory"); },
  ]);
  assert.deepEqual(calls, ["stop", "model", "memory"]);
  assert.deepEqual(failures, [failure]);
});

test("writeback requires one matching session and excludes injected context from exact native QA", () => {
  const body = { session_id: "native-session", messages: [
    { role: "user", content: USER_PROMPT, timestamp: 1 }, { role: "assistant", content: VISIBLE_REPLY, timestamp: 2 },
  ] };
  const request = { path: "/v1/memories/add", body };
  assertCleanWriteback([request], "native-session");
  for (const requests of [[], [request, request], [{ ...request, body: { ...body, session_id: "other" } }],
    [{ ...request, body: { ...body, messages: [...body.messages, { role: "user", content: "MemoraX Code reminder: injected" }] } }],
    [{ ...request, body: { ...body, messages: [{ role: "user", content: USER_PROMPT }, { role: "assistant", content: "reasoning " + VISIBLE_REPLY }] } }]]) {
    assert.throws(() => assertCleanWriteback(requests, "native-session"));
  }
});

test("stage logs redact fixture credentials and native authenticated UI URLs", () => {
  const safe = redactOutput(`${MEMORAX_KEY} ${MODEL_KEY} http://127.0.0.1:1234/?token=private-token&other=value`);
  assert.ok(!safe.includes(MEMORAX_KEY) && !safe.includes(MODEL_KEY) && !safe.includes("private-token"));
  assert.match(safe, /token=\[redacted\]&other=value/);
});

test("timed-out stages terminate the owned process and record the failure", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const logPath = join(root, "timeout.json");
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, logPath, timeout: 150,
  }), /timed out/);
  assert.equal(JSON.parse(await readFile(logPath, "utf8")).timedOut, true);
});

test("interrupted stages terminate their process while allowing subsequent cleanup", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const logPath = join(root, "interrupt.json");
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, logPath, signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 150);
  t.after(() => clearTimeout(timer));
  await assert.rejects(running, /interrupted/);
  const log = JSON.parse(await readFile(logPath, "utf8"));
  assert.equal(log.aborted, true);
  assert.equal(log.timedOut, false);
  const cleanup = await runProcess(process.execPath, ["-e", "process.stdout.write('cleanup')"], {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root },
  });
  assert.equal(cleanup.stdout, "cleanup");
});

test("the native network fence admits loopback and rejects HTTP, sockets, and redirect egress", async (t) => {
  const root = await temporaryRoot(t);
  const fence = fileURLToPath(new URL("./fixtures/local-network-only.mjs", import.meta.url));
  const source = `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const net = require('node:net');
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.invalid/blocked' }); }
      res.end('local');
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        assert.equal(await (await fetch(base)).text(), 'local');
        assert.throws(() => fetch('https://example.invalid/blocked'), /EXTERNAL_NETWORK_BLOCKED/);
        assert.throws(() => http.get('http://example.invalid/blocked'), /EXTERNAL_NETWORK_BLOCKED/);
        assert.throws(() => net.connect({host:'example.invalid',port:80}), /EXTERNAL_NETWORK_BLOCKED/);
        await assert.rejects(fetch(base + '/redirect'), (error) => /EXTERNAL_NETWORK_BLOCKED/.test(String(error.cause)));
        process.stdout.write('fence-pass');
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { server.close(); }
    });
  `;
  const result = await runProcess(process.execPath, ["--import", fence, "-e", source], {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, timeout: 10_000,
  });
  assert.equal(result.stdout, "fence-pass");
});

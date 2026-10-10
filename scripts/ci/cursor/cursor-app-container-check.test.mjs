import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  cleanupDockerResources, cursorAppNodeImage, cursorAppRelease, makeContainerArgs, projectNativeReport,
  readReleaseManifest, resolveLocalDockerEndpoint, stageCursorAppChecks, verifyCursorAppArtifact,
} from "./cursor-app-container-check.mjs";
import { baselineRelease } from "./cursor-app-release.mjs";

const runId = "11111111-1111-4111-8111-111111111111";
const containerId = "a".repeat(64), imageId = `sha256:${"b".repeat(64)}`;
const name = `memorax-cursor-app-ci-${runId}`, volume = `${name}-artifacts`;
const asset = (name) => new URL(`../../fixtures/cursor-app/${name}`, import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function releaseManifest() {
  const baseline = {}, latest = {};
  for (const platform of ["linux-x64", "linux-arm64"]) {
    baseline[platform] = { ...baselineRelease(platform) };
    latest[platform] = { ...baseline[platform], version: "3.21.19", commitSha: "d".repeat(40), channel: "latest",
      debVersion: "3.21.19-1790999999", sha256: "e".repeat(64), hashSource: "official-apt-sha256", size: 123456,
      url: baseline[platform].url.replaceAll(baseline[platform].version, "3.21.19")
        .replaceAll(baseline[platform].commitSha, "d".repeat(40)) };
  }
  return { schemaVersion: 1, baseline, latest };
}

function nativeReport() {
  return { status: "PASS", client: "cursor", kind: "app-native-session-flows", platform: "linux", node: "24.15.0",
    version: "3.21.18", stage: "complete", evidence: { agentTransport: true, nativeHooks: true, exactAutomaticAdd: true,
      sameSessionFollowup: true, sessionIsolation: true, workspaceIsolation: true, appResume: true, skillSearch: true, skillAdd: true,
      shellDenied: true, pendingShellInterrupted: true, sameSessionRecovered: true, repoMemoryWorker: true, cleanup: true,
      nativeContent: [3, 6, 3, 9, 15, 21, 4, 3, 4].map((blobCount) => ({ composerMatched: true, stateMatched: true, blobCount })) },
    agent: { runs: 11, ancillaryRequestCount: 5, unsupportedRpcCount: 1, cancelled: [false, false, false, false, false, false, false, true, false, false, false],
      errors: [], writes: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5], acknowledgements: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5], historyTurns: [0, 1, 0, 2, 3, 4, 0, 0, 0, 0, 0],
      reads: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0], readResults: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0],
      execRequests: [0, 0, 0, 0, 3, 3, 1, 1, 0, 1, 2], execResults: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2], execCloses: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2],
      contextRequests: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], contextResults: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], contextCloses: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }, memoryRequestCount: 11 };
}

test("every platform requires complete ordered native evidence, not just a PASS label", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const input = { ...nativeReport(), platform };
    const project = (value) => projectNativeReport(value, { platform });
    assert.deepEqual(project(input), input);
    const reject = (mutate) => {
      const invalid = structuredClone(input);
      mutate(invalid);
      assert.throws(() => project(invalid), { code: "CURSOR_CONTAINER_REPORT" });
    };
    for (const key of Object.keys(input.evidence).filter((key) => key !== "nativeContent")) {
      for (const value of [undefined, false, "true"]) reject((r) => { r.evidence[key] = value; });
    }
    for (const key of Object.keys(input.agent).filter((key) => Array.isArray(input.agent[key]) && key !== "errors")) {
      reject((r) => { delete r.agent[key]; });
      reject((r) => { r.agent[key].pop(); });
      reject((r) => { r.agent[key].push(0); });
      // Every turn matters, including denied, interrupted, recovered, parent and child.
      for (let index = 0; index < 11; index++) {
        reject((r) => { delete r.agent[key][index]; });
        reject((r) => { r.agent[key][index] = key === "cancelled" ? !r.agent[key][index] : r.agent[key][index] + 1; });
      }
      for (const value of ["1", NaN, -1]) reject((r) => { r.agent[key][0] = value; });
    }
    for (let index = 0; index < 9; index++) for (const key of ["composerMatched", "stateMatched", "blobCount"]) {
      reject((r) => { r.evidence.nativeContent[index][key] = key === "blobCount" ? 0 : false; });
    }
    for (const mutate of [
      (r) => { delete r.evidence.nativeContent; }, (r) => { r.evidence.nativeContent.pop(); },
      (r) => { delete r.evidence.nativeContent[1]; }, (r) => { r.evidence.nativeContent.reverse(); },
      (r) => { r.evidence.nativeContent[2] = r.evidence.nativeContent[1]; },
      (r) => { r.agent.runs--; }, (r) => { r.agent.errors = ["CURSOR_APP_EXEC_REJECTED"]; },
      (r) => { r.memoryRequestCount--; }, (r) => { r.memoryRequestCount++; },
      (r) => { r.stage = "native-submit"; }, (r) => { r.kind = "other"; },
      (r) => { r.platform = "other"; }, (r) => { r.version = "3.22.0"; },
      ...["errorCode", "cleanupError", "nativeContentError"].map((key) => (r) => { r[key] = "CURSOR_APP_CHECK_FAILED"; }),
    ]) reject(mutate);
  }
});

test("release pins distinguish official artifact provenance from observed checksums", () => {
  for (const arch of ["x64", "x86_64", "amd64"]) {
    const release = cursorAppRelease(arch);
    assert.equal(release.arch, "amd64");
    assert.equal(release.version, "3.21.18");
    assert.equal(release.platform, "linux-x64");
    assert.equal(release.channel, "baseline");
    assert.equal(release.debVersion, "3.21.18-1790045713");
    assert.equal(release.sha256, "6966b4a4082b802d10e985b8228d428020690b2ca43d6d1d74c10a0703d1e1b1");
    assert.equal(release.hashSource, "observed-sha256");
    assert.match(release.url, /^https:\/\/downloads\.cursor\.com\/production\/[a-f0-9]{40}\/linux\/x64\/deb\/amd64\/deb\/cursor_3\.21\.18_amd64\.deb$/);
  }
  assert.equal(cursorAppRelease("aarch64").arch, "arm64");
  assert.equal(cursorAppRelease("arm64").sha256, "d502d6a0dccc1472a5cec896b9526aace5e3dde8ba42775397f4366539ffc459");
  assert.throws(() => cursorAppRelease("ppc64"), /CURSOR_CONTAINER_ARCH/);
});

test("release selection uses daemon architecture and the requested frozen channel", () => {
  const manifest = releaseManifest();
  for (const [architecture, platform, arch] of [["amd64", "linux-x64", "amd64"], ["aarch64", "linux-arm64", "arm64"]]) {
    for (const channel of ["baseline", "latest"]) {
      assert.deepEqual(cursorAppRelease(architecture, { releaseManifest: manifest, channel }), { ...manifest[channel][platform], arch });
    }
  }
  assert.throws(() => cursorAppRelease("amd64", { channel: "latest" }), /CURSOR_CONTAINER_RELEASE/);
  assert.throws(() => cursorAppRelease("amd64", { releaseManifest: manifest, channel: "preview" }), /CURSOR_CONTAINER_RELEASE/);
});

test("release selection rejects missing hashes, mixed identity and malformed manifests", () => {
  for (const change of [
    (m) => { m.schemaVersion = 2; },
    (m) => { m.latest = []; },
    (m) => { delete m.latest["linux-x64"]; },
    (m) => { m.latest["linux-x64"] = m.latest["linux-arm64"]; },
    (m) => { m.latest["linux-x64"].channel = "baseline"; },
    (m) => { m.latest["linux-x64"].version = "3.21.20"; },
    (m) => { m.latest["linux-x64"].commitSha = "f".repeat(40); },
    (m) => { m.latest["linux-x64"].url = "https://untrusted.invalid/cursor.deb"; },
    (m) => { m.latest["linux-x64"].url += "?token=synthetic"; },
    (m) => { m.latest["linux-x64"].sha256 = null; },
    (m) => { m.latest["linux-x64"].sha256 = "g".repeat(64); },
    (m) => { m.latest["linux-x64"].hashSource = "not-provided"; },
    (m) => { delete m.latest["linux-x64"].size; },
    (m) => { m.latest["linux-x64"].size = "123456"; },
    (m) => { m.latest["linux-x64"].size = 0; },
    (m) => { delete m.latest["linux-x64"].debVersion; },
    (m) => { m.latest["linux-x64"].debVersion = "3.21.18-1790999999"; },
  ]) {
    const manifest = releaseManifest();
    change(manifest);
    assert.throws(() => cursorAppRelease("amd64", { releaseManifest: manifest, channel: "latest" }),
      { code: "CURSOR_CONTAINER_RELEASE", message: "CURSOR_CONTAINER_RELEASE" });
  }
});

test("manifest files must be bounded regular nonsymlink JSON objects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "manifest.json"), manifest = releaseManifest();
  await writeFile(path, JSON.stringify(manifest));
  assert.deepEqual(await readReleaseManifest(path), manifest);
  for (const text of ["{", "null", "[]", '{"schemaVersion":2}', " ".repeat(64 * 1024 + 1)]) {
    await writeFile(path, text);
    await assert.rejects(readReleaseManifest(path), { code: "CURSOR_CONTAINER_RELEASE_MANIFEST" });
  }
  await mkdir(join(root, "directory"));
  await assert.rejects(readReleaseManifest(join(root, "directory")), { code: "CURSOR_CONTAINER_RELEASE_MANIFEST" });
  await assert.rejects(readReleaseManifest(join(root, "missing")), { code: "CURSOR_CONTAINER_RELEASE_MANIFEST" });
  if (process.platform !== "win32") {
    await writeFile(path, JSON.stringify(manifest));
    await symlink(path, join(root, "linked.json"));
    await assert.rejects(readReleaseManifest(join(root, "linked.json")), { code: "CURSOR_CONTAINER_RELEASE_MANIFEST" });
  }
});

test("downloaded artifacts require the frozen SHA-256 and optional exact byte size", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "cursor.deb"), bytes = Buffer.from("synthetic Cursor package bytes");
  const release = { sha256: sha256(bytes), size: bytes.length };
  await writeFile(path, bytes);
  await verifyCursorAppArtifact(path, release);
  await verifyCursorAppArtifact(path, { sha256: release.sha256 });
  for (const change of [
    { sha256: "f".repeat(64) }, { sha256: null }, { sha256: "not-a-hash" },
    { size: bytes.length + 1 }, { size: bytes.length - 1 }, { size: null }, { size: 0 }, { size: String(bytes.length) },
  ]) {
    await assert.rejects(verifyCursorAppArtifact(path, { ...release, ...change }), { code: "CURSOR_CONTAINER_ARTIFACT_INTEGRITY" });
  }
  if (process.platform !== "win32") {
    await symlink(path, join(root, "linked.deb"));
    await assert.rejects(verifyCursorAppArtifact(join(root, "linked.deb"), release), { code: "CURSOR_CONTAINER_INPUT" });
  }
});

test("Node selection uses pinned real container images, not the host runtime", () => {
  assert.equal(cursorAppNodeImage("22"), "node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7");
  assert.equal(cursorAppNodeImage("24"), "node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4");
  for (const value of [undefined, null, 22, "20", "23", "22.23.3", "24;echo synthetic"]) {
    assert.throws(() => cursorAppNodeImage(value), { code: "CURSOR_CONTAINER_NODE" });
  }
});

test("wrapper CLI accepts only the legacy pair or complete manifest/channel/Node selection", () => {
  const script = new URL("./cursor-app-container-check.mjs", import.meta.url);
  for (const args of [[], ["candidate"], ["candidate", "report", "manifest"],
    ["candidate", "report", "manifest", "latest"], ["candidate", "report", "manifest", "latest", "22", "extra"]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: "utf8", timeout: 5_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "CURSOR_CONTAINER_ARGUMENTS");
  }
});

test("Docker endpoint selection follows context precedence and rejects remote daemons", async () => {
  const calls = [];
  const inspect = async (args) => { calls.push(args); return { code: 0, stdout: '"unix:///owned/docker.sock"' }; };
  assert.equal(await resolveLocalDockerEndpoint({}, inspect), "unix:///owned/docker.sock");
  assert.deepEqual(calls.pop(), ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
  assert.equal(await resolveLocalDockerEndpoint({ DOCKER_HOST: "unix:///other/docker.sock" }, inspect), "unix:///other/docker.sock");
  assert.equal(calls.length, 0);
  assert.equal(await resolveLocalDockerEndpoint({ DOCKER_CONTEXT: "local-test", DOCKER_HOST: "tcp://remote:2375" }, inspect), "unix:///owned/docker.sock");
  assert.deepEqual(calls.pop(), ["context", "inspect", "local-test", "--format", "{{json .Endpoints.docker.Host}}"]);
  for (const endpoint of ["tcp://remote:2375", "ssh://remote", "unix://remote/docker.sock", "unix:///bad\nsocket"]) {
    await assert.rejects(resolveLocalDockerEndpoint({ DOCKER_HOST: endpoint }, inspect), /CURSOR_CONTAINER_REMOTE_DOCKER/);
  }
  await assert.rejects(resolveLocalDockerEndpoint({ DOCKER_CONTEXT: "remote" }, async () => ({ code: 0, stdout: '"ssh://remote"' })), /CURSOR_CONTAINER_REMOTE_DOCKER/);
});

test("container arguments retain all isolation controls without host mounts or published ports", () => {
  const args = makeContainerArgs({ runId, imageId, seccompPath: "/owned/seccomp-profile.json" });
  for (const pair of [["--network", "none"], ["--cap-drop", "ALL"], ["--user", "1000:1000"],
    ["--memory", "3g"], ["--pids-limit", "1024"], ["--shm-size", "512m"], ["--ipc", "private"]]) {
    assert.equal(args[args.indexOf(pair[0]) + 1], pair[1]);
  }
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--init"));
  assert.ok(!args.includes("--pid"));
  assert.ok(args.includes("no-new-privileges=true"));
  assert.ok(args.includes("seccomp=/owned/seccomp-profile.json"));
  assert.ok(args.includes("/tmp:rw,nosuid,nodev,size=1g"));
  assert.ok(args.includes(`type=volume,source=${volume},destination=/artifacts`));
  assert.deepEqual(args.slice(args.indexOf(imageId) + 1), ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24",
    "node", "/opt/check/cursor/cursor-app-native-check.mjs", "/opt/candidate/node_modules/@memorax/memorax-code",
    "/opt/cursor-app/usr/share/cursor/cursor", "3.21.18", "/opt/probe/node_modules/playwright-core", "/artifacts", "24"]);
  assert.ok(!args.some((value) => /type=bind|docker\.sock|--privileged|--cap-add|--publish|--no-sandbox/.test(value)));
  assert.throws(() => makeContainerArgs({ runId: "other", imageId, seccompPath: "/owned/profile" }), /CURSOR_CONTAINER_IDENTITY/);
  assert.throws(() => makeContainerArgs({ runId, imageId: "other:latest", seccompPath: "/owned/profile" }), /CURSOR_CONTAINER_IDENTITY/);
  assert.throws(() => makeContainerArgs({ runId, imageId, seccompPath: "relative" }), /CURSOR_CONTAINER_SECCOMP/);
});

test("container arguments pass the selected App and Node versions into the native process", () => {
  const options = { runId, imageId, seccompPath: "/owned/profile", expectedVersion: "3.21.19", nodeMajor: "22" };
  const args = makeContainerArgs(options);
  assert.deepEqual(args.slice(-4), ["3.21.19", "/opt/probe/node_modules/playwright-core", "/artifacts", "22"]);
  for (const expectedVersion of ["latest", "3.21.19;echo synthetic", "3.21.19\n"]) {
    assert.throws(() => makeContainerArgs({ ...options, expectedVersion }), /CURSOR_CONTAINER_RELEASE/);
  }
  assert.throws(() => makeContainerArgs({ ...options, nodeMajor: "20" }), /CURSOR_CONTAINER_NODE/);
});

test("container staging preserves Cursor and Codex relative imports without copying the repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-staging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await stageCursorAppChecks(root);
  assert.deepEqual((await readdir(root)).sort(), ["codex", "cursor"]);
  assert.deepEqual(await readdir(join(root, "codex")), ["codex-native-content-check.mjs"]);
  assert.equal((await readdir(join(root, "cursor"))).length, 8);
  const staged = await import(pathToFileURL(join(root, "cursor", "cursor-app-memory-check.mjs")));
  assert.equal(typeof staged.assertCursorAppSkillReference, "function");
  assert.equal(typeof staged.assertCursorAppMemoryOperation, "function");
  const diagnostics = await import(pathToFileURL(join(root, "cursor", "cursor-app-hook-diagnostics.mjs")));
  assert.equal(typeof diagnostics.collectCursorAppHookDiagnostics, "function");
});

test("seccomp is the pinned Playwright profile with only the documented chroot allowance", async () => {
  const provenance = JSON.parse(await readFile(asset("provenance.json"), "utf8"));
  const raw = await readFile(asset("seccomp-profile.json"));
  assert.equal(sha256(raw), provenance.seccomp.sha256);
  const profile = JSON.parse(raw);
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert.deepEqual(profile.syscalls[0].names, ["chroot", "clone", "setns", "unshare"]);
  profile.syscalls[0].names.shift();
  profile.syscalls[0].comment = "Allow create user namespaces";
  assert.equal(sha256(`${JSON.stringify(profile, null, "\t")}\n`), provenance.seccomp.upstreamSha256);
  const dockerfile = await readFile(asset("Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG NODE_IMAGE\nFROM \$\{NODE_IMAGE\}\nARG NODE_MAJOR$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /dpkg-deb --extract/);
  assert.match(dockerfile, /sed -i 's\|http:\/\/deb\.debian\.org\/\|https:\/\/deb\.debian\.org\/\|g' \/etc\/apt\/sources\.list\.d\/debian\.sources/);
  assert.doesNotMatch(dockerfile, /dpkg -i|COPY \. |ADD https?:|--no-sandbox/);
});

test("Docker build checks the actual package and Node runtime against selected identities", async () => {
  const dockerfile = await readFile(asset("Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG CURSOR_DEB_VERSION\nARG CURSOR_APP_VERSION$/m);
  assert.match(dockerfile, /dpkg-deb --field \/tmp\/cursor.deb Version\)" = "\$CURSOR_DEB_VERSION"/);
  assert.match(dockerfile, /p\.version!==process\.env\.CURSOR_APP_VERSION/);
  assert.match(dockerfile, /String\(major\)!==process\.env\.NODE_MAJOR/);
  assert.match(dockerfile, /major===22&&minor<13/);
  assert.doesNotMatch(dockerfile, /p\.version!=="3\.21\.18"/);
});

test("report projection rejects a different App or Node runtime than the selected matrix cell", () => {
  for (const nodeMajor of ["22", "24"]) {
    const input = nativeReport();
    input.version = "3.21.19";
    input.node = nodeMajor === "22" ? "22.23.3" : "24.15.0";
    const expected = { expectedVersion: "3.21.19", nodeMajor };
    assert.equal(projectNativeReport(input, expected).status, "PASS");
    assert.throws(() => projectNativeReport(input, { ...expected, expectedVersion: "3.21.18" }), /CURSOR_CONTAINER_REPORT/);
    assert.throws(() => projectNativeReport(input, { ...expected, nodeMajor: nodeMajor === "22" ? "24" : "22" }), /CURSOR_CONTAINER_REPORT/);
    input.status = "FAIL";
    assert.throws(() => projectNativeReport(input, { ...expected, expectedVersion: "3.21.18" }), /CURSOR_CONTAINER_REPORT/);
    for (const node of ["20.20.0", "22.12.9", "22.13.0-rc.1", "v22.23.3", null]) {
      input.node = node;
      assert.throws(() => projectNativeReport(input, expected), /CURSOR_CONTAINER_REPORT/);
    }
  }
  const minimum = nativeReport();
  minimum.node = "22.13.0";
  assert.equal(projectNativeReport(minimum, { nodeMajor: "22" }).status, "PASS");
});

test("public reports drop raw data and project failure diagnostics without weakening the gate", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const project = (value) => projectNativeReport(value, { platform });
    const input = { ...nativeReport(), platform, privatePath: "private-canary" };
    input.evidence.nativeContent[0].databasePath = "private-canary";
    input.evidence.sessionIds = ["private-canary"];
    input.agent.requests = [{ token: "private-canary" }];
    assert.deepEqual(project(input), { ...nativeReport(), platform });

    input.status = "FAIL";
    input.stage = "automatic-add";
    input.errorCode = "CURSOR_APP_ADD_TIMEOUT";
    input.diagnostics = { turnStore: { readStatus: "present", versionMatched: true, clientMatched: true,
      sessionMatched: true, activePresent: false, token: "private-canary", diagnostics: [
        { operation: "memory.writeback", reason: "start_missing", scope: "turn", key: "private-canary" },
      ] } };
    input.appLaunch = { spawned: true, exitCode: 1, signal: "private-canary", log: "private-canary",
      markers: { permissionDenied: true } };
    input.nativeHooks = { readStatus: "present", filesRead: 1, raw: "private-canary", executions: [] };
    input.backendDiagnostics = { readStatus: "present", records: [
      { operation: "memory.turn-start", reason: "turn_state_unavailable", errorCode: "CURSOR_TURN_STATE_UNAVAILABLE",
        systemCode: "EACCES", error: "private-canary", sessionHash: "private-canary" },
    ] };
    input.candidateStop = { exitCode: 1, timedOut: true, stdout: "private-canary" };
    input.shellResult = { rejectionKind: 2, approvalClicked: true, exitCode: 127, stderr: "private-canary" };
    input.windowsAppStop = { taskkillExitCode: 128, childExitCode: 0, stderr: "private-canary" };
    const report = project(input);
    assert.equal(report.status, "FAIL");
    assert.equal(report.errorCode, input.errorCode);
    assert.deepEqual(report.diagnostics.turnStore.diagnostics, [
      { operation: "memory.writeback", reason: "start_missing", scope: "turn" },
    ]);
    assert.equal(report.appLaunch.exitCode, 1);
    assert.equal(report.appLaunch.signal, "other");
    assert.equal(report.nativeHooks.readStatus, "present");
    assert.equal(report.backendDiagnostics.records[0].errorCode, "CURSOR_TURN_STATE_UNAVAILABLE");
    assert.equal(report.candidateStop.timedOut, true);
    assert.deepEqual(report.shellResult, { rejectionKind: 2, approvalClicked: true, exitCode: 127 });
    assert.equal(report.windowsAppStop?.taskkillExitCode, platform === "win32" ? 128 : undefined);
    assert.equal(JSON.stringify(report).includes("private-canary"), false);
    input.status = "PASS";
    assert.throws(() => project(input), /CURSOR_CONTAINER_REPORT/);
    delete input.errorCode;
    input.stage = "complete";
    for (const key of ["candidateStop", "shellResult", "windowsAppStop", "nativeHooks", "backendDiagnostics"]) assert.equal(project(input)[key], undefined);
  }
});

test("FAIL retains valid partial progress but rejects arbitrary error text", () => {
  const input = { ...nativeReport(), status: "FAIL", errorCode: "CURSOR_APP_SESSION_TIMEOUT" };
  input.evidence.nativeContent.length = 2;
  input.agent.runs = 2;
  for (const key of Object.keys(input.agent)) if (Array.isArray(input.agent[key])) input.agent[key] = input.agent[key].slice(0, 2);
  for (const stage of ["workspace-switch", "app-restart", "session-open", "repo-memory-worker"]) {
    input.stage = stage;
    const report = projectNativeReport(input);
    assert.equal(report.stage, stage);
    assert.equal(report.evidence.nativeContent.length, 2);
    assert.equal(report.errorCode, input.errorCode);
  }
  input.errorCode = "private-canary";
  assert.throws(() => projectNativeReport(input), /CURSOR_CONTAINER_REPORT/);
});

function dockerFixture(rows = {}) {
  const calls = [];
  return { calls, run: async (args) => {
    calls.push(args);
    if (args.includes("ls")) return { code: 0, stdout: (rows[args[0]] ?? []).map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  } };
}
test("cleanup deletes only this run's labeled exact resources in dependency order", async () => {
  const docker = dockerFixture({ container: [{ ID: containerId, Names: name }], volume: [{ Name: volume }],
    image: [{ ID: imageId, Repository: "memorax-cursor-app-ci", Tag: runId }] });
  await cleanupDockerResources(runId, docker.run);
  assert.deepEqual(docker.calls.filter((args) => args.includes("rm")), [
    ["container", "rm", "--force", containerId], ["volume", "rm", volume], ["image", "rm", imageId],
  ]);
  for (const args of docker.calls.filter((args) => args.includes("ls"))) {
    assert.ok(args.includes(`label=memorax.cursor-app-ci=${runId}`));
  }
  await cleanupDockerResources(runId, dockerFixture().run);
});

test("cleanup refuses ambiguous ownership and preserves failure even when later resources clean up", async () => {
  const other = dockerFixture({ container: [{ ID: containerId, Names: "unrelated" }] });
  await assert.rejects(cleanupDockerResources(runId, other.run), /CURSOR_CONTAINER_CLEANUP/);
  assert.ok(!other.calls.some((args) => args.includes("rm")));
  let removals = 0;
  const docker = dockerFixture({ container: [{ ID: containerId, Names: name }], volume: [{ Name: volume }] });
  await assert.rejects(cleanupDockerResources(runId, async (args) => {
    if (args[0] === "container" && args.includes("rm")) return { code: 1, stdout: "", stderr: "synthetic cleanup failure" };
    if (args.includes("rm")) removals++;
    return docker.run(args);
  }), /CURSOR_CONTAINER_CLEANUP/);
  assert.equal(removals, 1);
});

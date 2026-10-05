import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  cleanupDockerResources, cursorAppRelease, makeContainerArgs, projectNativeReport, resolveLocalDockerEndpoint,
} from "./cursor-app-container-check.mjs";

const runId = "11111111-1111-4111-8111-111111111111";
const containerId = "a".repeat(64), imageId = `sha256:${"b".repeat(64)}`;
const name = `memorax-cursor-app-ci-${runId}`, volume = `${name}-artifacts`;
const asset = (name) => new URL(`./fixtures/cursor-app/${name}`, import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function nativeReport() {
  return { status: "PASS", client: "cursor", kind: "app-native-session-flows", platform: "linux", node: "24.15.0",
    version: "3.21.18", stage: "complete", evidence: { agentTransport: true, nativeHooks: true, exactAutomaticAdd: true,
      sameSessionFollowup: true, sessionIsolation: true, appResume: true, skillSearch: true, skillAdd: true, cleanup: true,
      nativeContent: [3, 6, 3, 9, 15, 21].map((blobCount) => ({ composerMatched: true, stateMatched: true, blobCount })) },
    agent: { runs: 6, ancillaryRequestCount: 5, unsupportedRpcCount: 1,
      errors: [], writes: [3, 3, 3, 3, 6, 6], acknowledgements: [3, 3, 3, 3, 6, 6], historyTurns: [0, 1, 0, 2, 3, 4],
      reads: [0, 3, 0, 6, 9, 15], readResults: [0, 3, 0, 6, 9, 15],
      execRequests: [0, 0, 0, 0, 3, 3], execResults: [0, 0, 0, 0, 3, 3], execCloses: [0, 0, 0, 0, 3, 3],
      contextRequests: [1, 1, 1, 1, 1, 1], contextResults: [1, 1, 1, 1, 1, 1], contextCloses: [1, 1, 1, 1, 1, 1] }, memoryRequestCount: 8 };
}

test("release pins distinguish official artifact provenance from observed checksums", () => {
  for (const arch of ["x64", "x86_64", "amd64"]) {
    const release = cursorAppRelease(arch);
    assert.equal(release.arch, "amd64");
    assert.equal(release.version, "3.21.18");
    assert.equal(release.sha256, "6966b4a4082b802d10e985b8228d428020690b2ca43d6d1d74c10a0703d1e1b1");
    assert.equal(release.hashSource, "observed-sha256");
    assert.match(release.url, /^https:\/\/downloads\.cursor\.com\/production\/[a-f0-9]{40}\/linux\/x64\/deb\/amd64\/deb\/cursor_3\.21\.18_amd64\.deb$/);
  }
  assert.equal(cursorAppRelease("aarch64").arch, "arm64");
  assert.equal(cursorAppRelease("arm64").sha256, "d502d6a0dccc1472a5cec896b9526aace5e3dde8ba42775397f4366539ffc459");
  assert.throws(() => cursorAppRelease("ppc64"), /CURSOR_CONTAINER_ARCH/);
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
    "node", "/opt/check/cursor-app-native-check.mjs", "/opt/candidate/node_modules/@memorax/memorax-code",
    "/opt/cursor-app/usr/share/cursor/cursor", "3.21.18", "/opt/probe/node_modules/playwright-core", "/artifacts"]);
  assert.ok(!args.some((value) => /type=bind|docker\.sock|--privileged|--cap-add|--publish|--no-sandbox/.test(value)));
  assert.throws(() => makeContainerArgs({ runId: "other", imageId, seccompPath: "/owned/profile" }), /CURSOR_CONTAINER_IDENTITY/);
  assert.throws(() => makeContainerArgs({ runId, imageId: "other:latest", seccompPath: "/owned/profile" }), /CURSOR_CONTAINER_IDENTITY/);
  assert.throws(() => makeContainerArgs({ runId, imageId, seccompPath: "relative" }), /CURSOR_CONTAINER_SECCOMP/);
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
  assert.match(dockerfile, new RegExp(`^FROM ${provenance.baseImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /dpkg-deb --extract/);
  assert.match(dockerfile, /sed -i 's\|http:\/\/deb\.debian\.org\/\|https:\/\/deb\.debian\.org\/\|g' \/etc\/apt\/sources\.list\.d\/debian\.sources/);
  assert.doesNotMatch(dockerfile, /dpkg -i|COPY \. |ADD https?:|--no-sandbox/);
});

test("report projection drops raw diagnostics and requires completed native evidence for PASS", () => {
  const input = nativeReport();
  input.privatePath = "/synthetic/private";
  input.evidence.nativeContent[0].databasePath = "/synthetic/native/database";
  input.evidence.sessionIds = ["synthetic-session-a", "synthetic-session-b"];
  input.agent.requests = [{ path: "/synthetic/private/token" }];
  input.agent.secret = "synthetic-token";
  const report = projectNativeReport(input);
  assert.equal(report.status, "PASS");
  assert.equal(report.agent.ancillaryRequestCount, 5);
  assert.deepEqual(report.agent.historyTurns, [0, 1, 0, 2, 3, 4]);
  assert.deepEqual(report.agent.reads, [0, 3, 0, 6, 9, 15]);
  assert.deepEqual(report.agent.readResults, [0, 3, 0, 6, 9, 15]);
  assert.deepEqual(report.agent.execRequests, [0, 0, 0, 0, 3, 3]);
  assert.deepEqual(report.agent.execResults, [0, 0, 0, 0, 3, 3]);
  assert.deepEqual(report.agent.execCloses, [0, 0, 0, 0, 3, 3]);
  assert.deepEqual(report.agent.contextRequests, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(report.agent.contextResults, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(report.agent.contextCloses, [1, 1, 1, 1, 1, 1]);
  assert.equal(report.evidence.skillSearch, true);
  assert.equal(report.evidence.skillAdd, true);
  assert.deepEqual(report.evidence.nativeContent, nativeReport().evidence.nativeContent);
  assert.equal(JSON.stringify(report).includes("synthetic"), false);
});

test("PASS rejects missing, reordered, duplicate or incomplete session-flow evidence", () => {
  for (const change of [
    (r) => { delete r.evidence.cleanup; }, (r) => { delete r.evidence.sameSessionFollowup; },
    (r) => { r.evidence.sessionIsolation = false; }, (r) => { delete r.evidence.appResume; },
    (r) => { delete r.evidence.skillSearch; }, (r) => { r.evidence.skillAdd = false; },
    (r) => { r.evidence.nativeContent[1].stateMatched = false; },
    (r) => { r.evidence.nativeContent[3].composerMatched = false; },
    (r) => { delete r.evidence.nativeContent; }, (r) => { r.evidence.nativeContent.pop(); },
    (r) => { delete r.evidence.nativeContent[1]; },
    (r) => { r.evidence.nativeContent.reverse(); },
    (r) => { r.evidence.nativeContent[2] = { ...r.evidence.nativeContent[1] }; },
    (r) => { r.evidence.nativeContent = r.evidence.nativeContent[0]; },
    (r) => { r.agent.acknowledgements = [3, 3, 3, 3, 6, 5]; }, (r) => { r.agent.writes = [3, 3, 3, 3, 6]; },
    (r) => { delete r.agent.writes[1]; }, (r) => { delete r.agent.acknowledgements[1]; },
    (r) => { r.agent.runs = 5; }, (r) => { delete r.agent.historyTurns; },
    (r) => { r.agent.historyTurns = [0, 0, 1, 2, 3, 4]; }, (r) => { r.agent.historyTurns = [0, 1, 0, 2, 3]; },
    (r) => { r.agent.historyTurns = [0, 1, 0, 0, 3, 4]; }, (r) => { r.agent.historyTurns[1] = "1"; },
    (r) => { delete r.agent.historyTurns[1]; },
    (r) => { delete r.agent.reads; }, (r) => { delete r.agent.readResults; },
    (r) => { r.agent.reads = [0, 0, 3, 6, 9, 15]; }, (r) => { r.agent.readResults = [0, 3, 0, 6, 9, 14]; },
    (r) => { r.agent.reads.pop(); }, (r) => { delete r.agent.readResults[3]; },
    (r) => { r.memoryRequestCount = 5; }, (r) => { r.kind = "app-native-single-turn"; },
    (r) => { r.nativeContentError = "CURSOR_APP_NATIVE_CONTENT_TIMEOUT"; },
    (r) => { r.version = "3.22.0"; }, (r) => { r.platform = "darwin"; },
  ]) {
    const invalid = nativeReport();
    change(invalid);
    assert.throws(() => projectNativeReport(invalid), /CURSOR_CONTAINER_REPORT/);
  }
});

test("PASS rejects missing, sparse, reordered and nonnumeric native tool or context evidence", () => {
  for (const field of ["execRequests", "execResults", "execCloses", "contextRequests", "contextResults", "contextCloses"]) {
    for (const change of [
      (r) => { delete r.agent[field]; },
      (r) => { delete r.agent[field][4]; },
      (r) => { r.agent[field].pop(); },
      (r) => { r.agent[field].push(3); },
      (r) => { if (field.startsWith("exec")) r.agent[field].reverse(); else r.agent[field][0] = 0; },
      (r) => { r.agent[field][5] = 2; },
      (r) => { r.agent[field][4] = "3"; },
      (r) => { r.agent[field][4] = NaN; },
      (r) => { r.agent[field] = { 4: 3, 5: 3 }; },
    ]) {
      const invalid = nativeReport();
      change(invalid);
      assert.throws(() => projectNativeReport(invalid), /CURSOR_CONTAINER_REPORT/);
    }
  }
});

test("FAIL preserves bounded partial evidence for restart and session-open diagnostics", () => {
  const failure = nativeReport();
  failure.status = "FAIL";
  failure.evidence.nativeContent = failure.evidence.nativeContent.slice(0, 2);
  failure.agent.runs = 2;
  failure.agent.writes = [3, 3];
  failure.agent.acknowledgements = [3, 3];
  failure.agent.historyTurns = [0, 1];
  failure.agent.reads = [0, 3];
  failure.agent.readResults = [0, 3];
  failure.agent.execRequests = [0, 0];
  failure.agent.execResults = [0, 0];
  failure.agent.execCloses = [0, 0];
  failure.agent.contextRequests = [1, 1];
  failure.agent.contextResults = [1, 1];
  failure.agent.contextCloses = [1, 1];
  failure.errorCode = "CURSOR_APP_SESSION_TIMEOUT";
  for (const stage of ["app-restart", "session-open"]) {
    failure.stage = stage;
    const report = projectNativeReport(failure);
    assert.equal(report.stage, stage);
    assert.equal(report.errorCode, "CURSOR_APP_SESSION_TIMEOUT");
    assert.equal(report.evidence.nativeContent.length, 2);
  }
  failure.errorCode = "synthetic-token";
  assert.throws(() => projectNativeReport(failure), /CURSOR_CONTAINER_REPORT/);
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

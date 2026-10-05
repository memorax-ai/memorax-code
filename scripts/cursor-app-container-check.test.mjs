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
  return { status: "PASS", client: "cursor", kind: "app-native-single-turn", platform: "linux", node: "24.15.0",
    version: "3.21.18", stage: "complete", evidence: { agentTransport: true, nativeHooks: true, exactAutomaticAdd: true,
      cleanup: true, nativeContent: { composerMatched: true, stateMatched: true, blobCount: 3 } },
    agent: { runs: 1, ancillaryRequestCount: 5, unsupportedRpcCount: 1,
      errors: [], writes: [3], acknowledgements: [3] }, memoryRequestCount: 1 };
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
  input.agent.requests = [{ path: "/synthetic/private/token" }];
  input.agent.secret = "synthetic-token";
  const report = projectNativeReport(input);
  assert.equal(report.status, "PASS");
  assert.equal(report.agent.ancillaryRequestCount, 5);
  assert.equal(JSON.stringify(report).includes("synthetic"), false);
  for (const change of [
    (r) => { delete r.evidence.cleanup; }, (r) => { r.evidence.nativeContent.stateMatched = false; },
    (r) => { r.agent.acknowledgements = [2]; }, (r) => { r.memoryRequestCount = 2; },
    (r) => { r.version = "3.22.0"; }, (r) => { r.platform = "darwin"; },
  ]) {
    const invalid = nativeReport();
    change(invalid);
    assert.throws(() => projectNativeReport(invalid), /CURSOR_CONTAINER_REPORT/);
  }
  const failure = nativeReport();
  failure.status = "FAIL";
  failure.stage = "agent-transport";
  failure.errorCode = "CURSOR_APP_AGENT_TIMEOUT";
  assert.equal(projectNativeReport(failure).errorCode, "CURSOR_APP_AGENT_TIMEOUT");
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

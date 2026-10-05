import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { baselineRelease, validateLinuxRelease } from "./cursor-app-release.mjs";
import { projectCursorAppDiagnostics } from "./cursor-app-diagnostics.mjs";

const exec = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const assets = join(scripts, "fixtures/cursor-app");
const provenance = JSON.parse(readFileSync(join(assets, "provenance.json"), "utf8"));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const label = "memorax.cursor-app-ci";
const codePattern = /^CURSOR_(?:APP|MOCK|AGENT|CONTAINER)_[A-Z0-9_]{1,100}$/;
const stages = new Set(["preflight", "candidate-install", "app-start", "native-submit", "agent-transport",
  "native-persistence", "automatic-add", "app-restart", "session-open", "pending-shell-interruption", "cleanup", "complete"]);
const completedEvidence = ["agentTransport", "nativeHooks", "exactAutomaticAdd", "sameSessionFollowup", "sessionIsolation", "appResume",
  "skillSearch", "skillAdd", "pendingShellInterrupted", "cleanup"];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(value, code) { if (!value) fail(code); }
function count(value) { check(Number.isSafeInteger(value) && value >= 0, "CURSOR_CONTAINER_REPORT"); return value; }
function safeCode(error) { return codePattern.test(error?.code) ? error.code : "CURSOR_CONTAINER_FAILED"; }
function resourceNames(runId) {
  check(typeof runId === "string" && uuid.test(runId), "CURSOR_CONTAINER_IDENTITY");
  const name = `memorax-cursor-app-ci-${runId}`;
  return { name, volume: `${name}-artifacts`, image: `memorax-cursor-app-ci:${runId}` };
}

export function cursorAppRelease(architecture, { releaseManifest, channel = "baseline" } = {}) {
  const arch = ["x64", "x86_64", "amd64"].includes(architecture) ? "amd64"
    : ["arm64", "aarch64"].includes(architecture) ? "arm64" : undefined;
  check(arch, "CURSOR_CONTAINER_ARCH");
  check(["baseline", "latest"].includes(channel), "CURSOR_CONTAINER_RELEASE");
  const platform = arch === "amd64" ? "linux-x64" : "linux-arm64";
  check(releaseManifest === undefined ? channel === "baseline"
    : releaseManifest?.schemaVersion === 1 && typeof releaseManifest[channel] === "object"
      && releaseManifest[channel] !== null && !Array.isArray(releaseManifest[channel]), "CURSOR_CONTAINER_RELEASE");
  const descriptor = releaseManifest === undefined ? baselineRelease(platform) : releaseManifest[channel][platform];
  check(descriptor?.channel === channel, "CURSOR_CONTAINER_RELEASE");
  try { return { ...validateLinuxRelease(descriptor, platform), arch }; }
  catch { fail("CURSOR_CONTAINER_RELEASE"); }
}

export function cursorAppNodeImage(nodeMajor) {
  check(["22", "24"].includes(nodeMajor), "CURSOR_CONTAINER_NODE");
  const image = provenance.baseImages?.[nodeMajor];
  check(typeof image === "string" && new RegExp(`^node:${nodeMajor}-bookworm@sha256:[a-f0-9]{64}$`).test(image), "CURSOR_CONTAINER_NODE");
  return image;
}

export function makeContainerArgs({ runId, imageId, seccompPath, expectedVersion = provenance.cursor.version, nodeMajor = "24" }) {
  const { name, volume } = resourceNames(runId);
  check(imagePattern.test(imageId), "CURSOR_CONTAINER_IDENTITY");
  check(isAbsolute(seccompPath) && !/[\0\r\n]/.test(seccompPath), "CURSOR_CONTAINER_SECCOMP");
  check(typeof expectedVersion === "string" && versionPattern.test(expectedVersion), "CURSOR_CONTAINER_RELEASE");
  cursorAppNodeImage(nodeMajor);
  return ["create", "--name", name, "--label", `${label}=${runId}`, "--init", "--user", "1000:1000",
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--security-opt", `seccomp=${seccompPath}`, "--ipc", "private",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g", "--shm-size", "512m", "--memory", "3g", "--pids-limit", "1024",
    "--mount", `type=volume,source=${volume},destination=/artifacts`, imageId,
    "xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24", "node", "/opt/check/cursor-app-native-check.mjs",
    "/opt/candidate/node_modules/@memorax/memorax-code", "/opt/cursor-app/usr/share/cursor/cursor", expectedVersion,
    "/opt/probe/node_modules/playwright-core", "/artifacts", nodeMajor];
}

export function projectNativeReport(input, { expectedVersion = provenance.cursor.version, nodeMajor = "24" } = {}) {
  check(typeof expectedVersion === "string" && versionPattern.test(expectedVersion), "CURSOR_CONTAINER_RELEASE");
  cursorAppNodeImage(nodeMajor);
  const nodeVersion = typeof input?.node === "string" && input.node.match(versionPattern);
  check(input && ["PASS", "FAIL"].includes(input.status) && input.client === "cursor"
    && input.kind === "app-native-session-flows" && input.platform === "linux"
    && nodeVersion && nodeVersion[1] === nodeMajor && (nodeMajor !== "22" || Number(nodeVersion[2]) >= 13)
    && stages.has(input.stage), "CURSOR_CONTAINER_REPORT");
  const report = { status: input.status, client: "cursor", kind: input.kind, platform: "linux", node: input.node,
    stage: input.stage, evidence: {} };
  if (input.version !== undefined) {
    check(input.version === expectedVersion, "CURSOR_CONTAINER_REPORT");
    report.version = input.version;
  }
  for (const key of ["errorCode", "cleanupError", "nativeContentError"]) if (input[key] !== undefined) {
    check(typeof input[key] === "string" && codePattern.test(input[key]), "CURSOR_CONTAINER_REPORT");
    report[key] = input[key];
  }
  for (const key of completedEvidence) if (input.evidence?.[key] !== undefined) {
    check(typeof input.evidence[key] === "boolean", "CURSOR_CONTAINER_REPORT");
    report.evidence[key] = input.evidence[key];
  }
  const content = input.evidence?.nativeContent;
  if (content !== undefined) {
    check(Array.isArray(content), "CURSOR_CONTAINER_REPORT");
    report.evidence.nativeContent = content.map((item) => {
      check(item && typeof item.composerMatched === "boolean" && typeof item.stateMatched === "boolean", "CURSOR_CONTAINER_REPORT");
      return { composerMatched: item.composerMatched, stateMatched: item.stateMatched, blobCount: count(item.blobCount) };
    });
  }
  if (input.agent !== undefined) {
    const agent = input.agent;
    check(Array.isArray(agent.writes) && Array.isArray(agent.acknowledgements) && Array.isArray(agent.historyTurns)
      && Array.isArray(agent.reads) && Array.isArray(agent.readResults)
      && Array.isArray(agent.execRequests) && Array.isArray(agent.execResults) && Array.isArray(agent.execCloses)
      && Array.isArray(agent.contextRequests) && Array.isArray(agent.contextResults) && Array.isArray(agent.contextCloses)
      && Array.isArray(agent.errors ?? []) && (agent.errors ?? []).every((value) => typeof value === "string" && codePattern.test(value)), "CURSOR_CONTAINER_REPORT");
    report.agent = { runs: count(agent.runs), writes: agent.writes.map(count), acknowledgements: agent.acknowledgements.map(count),
      historyTurns: agent.historyTurns.map(count), reads: agent.reads.map(count), readResults: agent.readResults.map(count),
      execRequests: agent.execRequests.map(count), execResults: agent.execResults.map(count), execCloses: agent.execCloses.map(count),
      contextRequests: agent.contextRequests.map(count), contextResults: agent.contextResults.map(count), contextCloses: agent.contextCloses.map(count),
      ancillaryRequestCount: count(agent.ancillaryRequestCount), unsupportedRpcCount: count(agent.unsupportedRpcCount), errors: agent.errors ?? [] };
    check(Array.isArray(agent.cancelled) && agent.cancelled.every((value) => typeof value === "boolean"), "CURSOR_CONTAINER_REPORT");
    report.agent.cancelled = [...agent.cancelled];
  }
  if (input.memoryRequestCount !== undefined) report.memoryRequestCount = count(input.memoryRequestCount);
  if (input.diagnostics !== undefined) report.diagnostics = projectCursorAppDiagnostics(input.diagnostics);
  if (report.status === "PASS") check(report.stage === "complete" && report.version === expectedVersion && !report.errorCode && !report.cleanupError && !report.nativeContentError
    && completedEvidence.every((key) => report.evidence[key] === true)
    && content?.length === 6 && [3, 6, 3, 9, 15, 21].every((blobs, index) => content[index]?.composerMatched === true
      && content[index]?.stateMatched === true && content[index]?.blobCount === blobs)
    && report.agent?.runs === 7 && report.agent.writes.length === 7 && [3, 3, 3, 3, 6, 6, 0].every((value, index) => report.agent.writes[index] === value)
    && report.agent.acknowledgements.length === 7 && [3, 3, 3, 3, 6, 6, 0].every((value, index) => report.agent.acknowledgements[index] === value)
    && report.agent.historyTurns.length === 7 && [0, 1, 0, 2, 3, 4, 0].every((value, index) => report.agent.historyTurns[index] === value)
    && report.agent.reads.length === 7 && [0, 3, 0, 6, 9, 15, 0].every((value, index) => report.agent.reads[index] === value)
    && report.agent.readResults.length === 7 && [0, 3, 0, 6, 9, 15, 0].every((value, index) => report.agent.readResults[index] === value)
    && report.agent.execRequests.length === 7 && [0, 0, 0, 0, 3, 3, 1].every((value, index) => report.agent.execRequests[index] === value)
    && report.agent.execResults.length === 7 && [0, 0, 0, 0, 3, 3, 0].every((value, index) => report.agent.execResults[index] === value)
    && report.agent.execCloses.length === 7 && [0, 0, 0, 0, 3, 3, 0].every((value, index) => report.agent.execCloses[index] === value)
    && report.agent.contextRequests.length === 7 && [1, 1, 1, 1, 1, 1, 1].every((value, index) => report.agent.contextRequests[index] === value)
    && report.agent.contextResults.length === 7 && [1, 1, 1, 1, 1, 1, 1].every((value, index) => report.agent.contextResults[index] === value)
    && report.agent.contextCloses.length === 7 && [1, 1, 1, 1, 1, 1, 1].every((value, index) => report.agent.contextCloses[index] === value)
    && report.agent.cancelled.length === 7 && [false, false, false, false, false, false, true].every((value, index) => report.agent.cancelled[index] === value)
    && report.agent.errors.length === 0 && report.memoryRequestCount === 8, "CURSOR_CONTAINER_REPORT");
  return report;
}

async function command(file, args, { timeout = 60_000, signal, env = process.env } = {}) {
  try { return { code: 0, ...await exec(file, args, { timeout, signal, env, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" }) }; }
  catch (error) {
    if (typeof error.code === "number" && !error.killed) return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    fail(error.killed || error.name === "AbortError" ? "CURSOR_CONTAINER_COMMAND_TIMEOUT" : "CURSOR_CONTAINER_COMMAND_FAILED");
  }
}
const docker = (args, options) => command("docker", args, options);
async function checkedDocker(args, options, run = docker) {
  const result = await run(args, options);
  check(result.code === 0, "CURSOR_CONTAINER_DOCKER_FAILED");
  return result.stdout.trim();
}

export async function resolveLocalDockerEndpoint(env = process.env, run = docker) {
  let endpoint = env.DOCKER_HOST;
  if (env.DOCKER_CONTEXT || !endpoint) {
    const args = ["context", "inspect", ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), "--format", "{{json .Endpoints.docker.Host}}"];
    endpoint = JSON.parse(await checkedDocker(args, undefined, run));
  }
  check(typeof endpoint === "string" && /^unix:\/\/\/[^\0\r\n]+$/.test(endpoint), "CURSOR_CONTAINER_REMOTE_DOCKER");
  return endpoint;
}

export async function cleanupDockerResources(runId, run = docker) {
  const { name, volume } = resourceNames(runId);
  let failed = false;
  for (const kind of ["container", "volume", "image"]) {
    try {
      const args = [kind, "ls", ...(kind === "container" ? ["--all", "--no-trunc"] : kind === "image" ? ["--no-trunc"] : []),
        "--filter", `label=${label}=${runId}`, "--format", "{{json .}}"];
      const listed = await run(args);
      check(listed.code === 0, "CURSOR_CONTAINER_CLEANUP");
      const rows = listed.stdout.trim() ? listed.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
      const targets = new Set();
      for (const row of rows) {
        if (kind === "container") {
          check(row.Names === name && /^[a-f0-9]{64}$/.test(row.ID), "CURSOR_CONTAINER_CLEANUP");
          targets.add(row.ID);
        } else if (kind === "volume") {
          check(row.Name === volume, "CURSOR_CONTAINER_CLEANUP");
          targets.add(row.Name);
        } else {
          check(row.Repository === "memorax-cursor-app-ci" && row.Tag === runId && imagePattern.test(row.ID), "CURSOR_CONTAINER_CLEANUP");
          targets.add(row.ID);
        }
      }
      for (const target of targets) {
        const removed = await run([kind, "rm", ...(kind === "container" ? ["--force"] : []), target]);
        check(removed.code === 0, "CURSOR_CONTAINER_CLEANUP");
      }
    } catch { failed = true; }
  }
  check(!failed, "CURSOR_CONTAINER_CLEANUP");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function regularFile(path) {
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink(), "CURSOR_CONTAINER_INPUT");
  return info;
}

export async function verifyCursorAppArtifact(path, release) {
  const info = await regularFile(path);
  check(typeof release?.sha256 === "string" && /^[a-f0-9]{64}$/.test(release.sha256)
    && (release.size === undefined || Number.isSafeInteger(release.size) && release.size > 0 && info.size === release.size),
  "CURSOR_CONTAINER_ARTIFACT_INTEGRITY");
  check(await hashFile(path) === release.sha256, "CURSOR_CONTAINER_ARTIFACT_INTEGRITY");
}

export async function readReleaseManifest(path) {
  try {
    check(typeof path === "string" && path.length > 0 && !/[\0\r\n]/.test(path), "CURSOR_CONTAINER_RELEASE_MANIFEST");
    check((await regularFile(path)).size <= 64 * 1024, "CURSOR_CONTAINER_RELEASE_MANIFEST");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    check(manifest && typeof manifest === "object" && !Array.isArray(manifest) && manifest.schemaVersion === 1,
      "CURSOR_CONTAINER_RELEASE_MANIFEST");
    return manifest;
  } catch { fail("CURSOR_CONTAINER_RELEASE_MANIFEST"); }
}

export async function runContainerCheck(candidatePath, reportPath, { releaseManifest, channel = "baseline", nodeMajor = "24", signal } = {}) {
  const runId = randomUUID(), names = resourceNames(runId);
  let report = { status: "FAIL", client: "cursor", kind: "app-native-session-flows", stage: "container-preflight", evidence: {} };
  let root, output, dockerStarted = false, cleaned = false, metadata, runDocker = docker;
  const checked = (args, options) => checkedDocker(args, options, runDocker);
  try {
    check(["linux", "darwin"].includes(process.platform), "CURSOR_CONTAINER_HOST");
    check(typeof candidatePath === "string" && typeof reportPath === "string"
      && !/[\0\r\n]/.test(candidatePath + reportPath), "CURSOR_CONTAINER_INPUT");
    const candidate = resolve(candidatePath), destination = resolve(reportPath);
    await regularFile(candidate);
    try { await mkdir(destination, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const directory = await lstat(destination);
    check(directory.isDirectory() && !directory.isSymbolicLink() && (await readdir(destination)).length === 0, "CURSOR_CONTAINER_OUTPUT");
    output = await realpath(destination);
    const nodeImage = cursorAppNodeImage(nodeMajor);
    check(["baseline", "latest"].includes(channel), "CURSOR_CONTAINER_RELEASE");
    root = await mkdtemp(join(tmpdir(), "memorax-cursor-app-ci-"));
    const endpoint = await resolveLocalDockerEndpoint();
    const dockerEnvironment = { ...process.env, DOCKER_CONTEXT: "", DOCKER_HOST: endpoint };
    runDocker = (args, options) => command("docker", ["--host", endpoint, ...args], { ...options, env: dockerEnvironment });
    const info = JSON.parse(await checked(["info", "--format", "{{json .}}"], { signal }));
    check(info.OSType === "linux", "CURSOR_CONTAINER_DAEMON");
    const release = cursorAppRelease(info.Architecture, { releaseManifest, channel });
    metadata = { architecture: release.arch, platform: release.platform, channel, nodeMajor, version: release.version,
      commitSha: release.commitSha, sha256: release.sha256, hashSource: release.hashSource, cleanup: false };
    report.stage = "container-acquisition";
    const deb = join(root, "cursor.deb");
    const downloaded = await command("curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--connect-timeout", "20", "--max-time", "600", "--retry", "2", "--max-filesize", "300000000", "--silent", "--show-error",
      "--output", deb, release.url], { timeout: 610_000, signal });
    check(downloaded.code === 0, "CURSOR_CONTAINER_DOWNLOAD_FAILED");
    await verifyCursorAppArtifact(deb, release);
    await copyFile(candidate, join(root, "candidate.tgz"));
    await copyFile(join(assets, "Dockerfile"), join(root, "Dockerfile"));
    await copyFile(join(assets, "seccomp-profile.json"), join(root, "seccomp-profile.json"));
    check(await hashFile(join(root, "seccomp-profile.json")) === provenance.seccomp.sha256, "CURSOR_CONTAINER_SECCOMP");
    await mkdir(join(root, "check"));
    for (const name of ["cursor-app-native-check.mjs", "cursor-app-protocol.mjs", "cursor-app-mock-server.mjs", "cursor-app-native-content-check.mjs",
      "cursor-app-memory-check.mjs", "cursor-app-diagnostics.mjs", "codex-native-content-check.mjs"]) {
      await regularFile(join(scripts, name));
      await copyFile(join(scripts, name), join(root, "check", name));
    }
    report.stage = "container-build";
    dockerStarted = true;
    await checked(["build", "--label", `${label}=${runId}`, "--tag", names.image,
      "--build-arg", `NODE_IMAGE=${nodeImage}`, "--build-arg", `NODE_MAJOR=${nodeMajor}`,
      "--build-arg", `CURSOR_APP_VERSION=${release.version}`, "--build-arg", `CURSOR_DEB_VERSION=${release.debVersion}`,
      "--file", join(root, "Dockerfile"), root], { timeout: 20 * 60_000, signal });
    report.stage = "container-create";
    const imageId = await checked(["image", "inspect", "--format", "{{.Id}}", names.image], { signal });
    check(imagePattern.test(imageId), "CURSOR_CONTAINER_IDENTITY");
    await checked(["volume", "create", "--label", `${label}=${runId}`, names.volume], { signal });
    const expected = { expectedVersion: release.version, nodeMajor };
    const containerId = await checked(makeContainerArgs({ runId, imageId, seccompPath: join(root, "seccomp-profile.json"), ...expected }), { signal });
    check(/^[a-f0-9]{64}$/.test(containerId), "CURSOR_CONTAINER_IDENTITY");
    report.stage = "container-native";
    const started = await runDocker(["start", "--attach", containerId], { timeout: 10 * 60_000, signal });
    const state = JSON.parse(await checked(["container", "inspect", "--format", "{{json .State}}", containerId], { signal }));
    check(state.Running === false && Number.isInteger(state.ExitCode), "CURSOR_CONTAINER_STATE");
    await checked(["cp", `${containerId}:/artifacts/report.json`, join(root, "native-report.json")], { signal });
    const reportFile = await regularFile(join(root, "native-report.json"));
    check(reportFile.size <= 64 * 1024, "CURSOR_CONTAINER_REPORT");
    report = projectNativeReport(JSON.parse(await readFile(join(root, "native-report.json"), "utf8")), expected);
    check(started.code === 0 && state.ExitCode === 0, "CURSOR_CONTAINER_NATIVE_EXIT");
  } catch (error) {
    report.status = "FAIL";
    report.errorCode ??= safeCode(error);
  } finally {
    try {
      if (dockerStarted) await cleanupDockerResources(runId, runDocker);
      cleaned = true;
      if (metadata) metadata.cleanup = true;
    } catch {
      report.status = "FAIL";
      report.containerCleanupError = "CURSOR_CONTAINER_CLEANUP";
    }
    if (metadata) report.container = metadata;
    if (root && cleaned) {
      try { await rm(root, { recursive: true, force: true }); }
      catch { report.status = "FAIL"; report.containerCleanupError = "CURSOR_CONTAINER_LOCAL_CLEANUP"; }
    }
    if (output) await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  try {
    check([4, 7].includes(process.argv.length), "CURSOR_CONTAINER_ARGUMENTS");
    const selection = process.argv.length === 7 ? {
      releaseManifest: await readReleaseManifest(process.argv[4]), channel: process.argv[5], nodeMajor: process.argv[6],
    } : {};
    const report = await runContainerCheck(process.argv[2], process.argv[3], { ...selection, signal: abort.signal });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(safeCode(error));
    process.exitCode = 1;
  }
}

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const assets = join(scripts, "fixtures/cursor-app");
const provenance = JSON.parse(readFileSync(join(assets, "provenance.json"), "utf8"));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const label = "memorax.cursor-app-ci";
const codePattern = /^CURSOR_(?:APP|MOCK|AGENT|CONTAINER)_[A-Z0-9_]{1,100}$/;
const stages = new Set(["preflight", "candidate-install", "app-start", "native-submit", "agent-transport",
  "native-persistence", "automatic-add", "cleanup", "complete"]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(value, code) { if (!value) fail(code); }
function count(value) { check(Number.isSafeInteger(value) && value >= 0, "CURSOR_CONTAINER_REPORT"); return value; }
function safeCode(error) { return codePattern.test(error?.code) ? error.code : "CURSOR_CONTAINER_FAILED"; }
function resourceNames(runId) {
  check(typeof runId === "string" && uuid.test(runId), "CURSOR_CONTAINER_IDENTITY");
  const name = `memorax-cursor-app-ci-${runId}`;
  return { name, volume: `${name}-artifacts`, image: `memorax-cursor-app-ci:${runId}` };
}

export function cursorAppRelease(architecture) {
  const arch = ["x64", "x86_64", "amd64"].includes(architecture) ? "amd64"
    : ["arm64", "aarch64"].includes(architecture) ? "arm64" : undefined;
  check(arch, "CURSOR_CONTAINER_ARCH");
  return { arch, version: provenance.cursor.version, hashSource: provenance.cursor.hashSource, ...provenance.cursor[arch] };
}

export function makeContainerArgs({ runId, imageId, seccompPath }) {
  const { name, volume } = resourceNames(runId);
  check(imagePattern.test(imageId), "CURSOR_CONTAINER_IDENTITY");
  check(isAbsolute(seccompPath) && !/[\0\r\n]/.test(seccompPath), "CURSOR_CONTAINER_SECCOMP");
  return ["create", "--name", name, "--label", `${label}=${runId}`, "--init", "--user", "1000:1000",
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--security-opt", `seccomp=${seccompPath}`, "--ipc", "private",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g", "--shm-size", "512m", "--memory", "3g", "--pids-limit", "1024",
    "--mount", `type=volume,source=${volume},destination=/artifacts`, imageId,
    "xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24", "node", "/opt/check/cursor-app-native-check.mjs",
    "/opt/candidate/node_modules/@memorax/memorax-code", "/opt/cursor-app/usr/share/cursor/cursor", "3.21.18",
    "/opt/probe/node_modules/playwright-core", "/artifacts"];
}

export function projectNativeReport(input) {
  check(input && ["PASS", "FAIL"].includes(input.status) && input.client === "cursor"
    && input.kind === "app-native-single-turn" && input.platform === "linux"
    && /^24\.\d+\.\d+$/.test(input.node) && stages.has(input.stage), "CURSOR_CONTAINER_REPORT");
  const report = { status: input.status, client: "cursor", kind: input.kind, platform: "linux", node: input.node,
    stage: input.stage, evidence: {} };
  if (input.version !== undefined) {
    check(input.version === "3.21.18", "CURSOR_CONTAINER_REPORT");
    report.version = input.version;
  }
  for (const key of ["errorCode", "cleanupError", "nativeContentError"]) if (input[key] !== undefined) {
    check(typeof input[key] === "string" && codePattern.test(input[key]), "CURSOR_CONTAINER_REPORT");
    report[key] = input[key];
  }
  for (const key of ["agentTransport", "nativeHooks", "exactAutomaticAdd", "cleanup"]) if (input.evidence?.[key] !== undefined) {
    check(typeof input.evidence[key] === "boolean", "CURSOR_CONTAINER_REPORT");
    report.evidence[key] = input.evidence[key];
  }
  const content = input.evidence?.nativeContent;
  if (content !== undefined) {
    check(typeof content.composerMatched === "boolean" && typeof content.stateMatched === "boolean", "CURSOR_CONTAINER_REPORT");
    report.evidence.nativeContent = { composerMatched: content.composerMatched, stateMatched: content.stateMatched, blobCount: count(content.blobCount) };
  }
  if (input.agent !== undefined) {
    const agent = input.agent;
    check(Array.isArray(agent.writes) && Array.isArray(agent.acknowledgements)
      && Array.isArray(agent.errors ?? []) && (agent.errors ?? []).every((value) => typeof value === "string" && codePattern.test(value)), "CURSOR_CONTAINER_REPORT");
    report.agent = { runs: count(agent.runs), writes: agent.writes.map(count), acknowledgements: agent.acknowledgements.map(count),
      ancillaryRequestCount: count(agent.ancillaryRequestCount), unsupportedRpcCount: count(agent.unsupportedRpcCount), errors: agent.errors ?? [] };
  }
  if (input.memoryRequestCount !== undefined) report.memoryRequestCount = count(input.memoryRequestCount);
  if (report.status === "PASS") check(report.stage === "complete" && report.version === "3.21.18" && !report.errorCode && !report.cleanupError && !report.nativeContentError
    && ["agentTransport", "nativeHooks", "exactAutomaticAdd", "cleanup"].every((key) => report.evidence[key] === true)
    && content?.composerMatched === true && content?.stateMatched === true && content.blobCount === 3
    && report.agent?.runs === 1 && report.agent.writes.length === 1 && report.agent.writes[0] === 3
    && report.agent.acknowledgements.length === 1 && report.agent.acknowledgements[0] === 3
    && report.agent.errors.length === 0 && report.memoryRequestCount === 1, "CURSOR_CONTAINER_REPORT");
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

export async function runContainerCheck(candidatePath, reportPath, { signal } = {}) {
  const runId = randomUUID(), names = resourceNames(runId);
  let report = { status: "FAIL", client: "cursor", kind: "app-native-single-turn", stage: "container-preflight", evidence: {} };
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
    root = await mkdtemp(join(tmpdir(), "memorax-cursor-app-ci-"));
    const endpoint = await resolveLocalDockerEndpoint();
    const dockerEnvironment = { ...process.env, DOCKER_CONTEXT: "", DOCKER_HOST: endpoint };
    runDocker = (args, options) => command("docker", ["--host", endpoint, ...args], { ...options, env: dockerEnvironment });
    const info = JSON.parse(await checked(["info", "--format", "{{json .}}"], { signal }));
    check(info.OSType === "linux", "CURSOR_CONTAINER_DAEMON");
    const release = cursorAppRelease(info.Architecture);
    metadata = { architecture: release.arch, version: release.version, sha256: release.sha256, hashSource: release.hashSource, cleanup: false };
    report.stage = "container-acquisition";
    const deb = join(root, "cursor.deb");
    const downloaded = await command("curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--connect-timeout", "20", "--max-time", "600", "--retry", "2", "--max-filesize", "300000000", "--silent", "--show-error",
      "--output", deb, release.url], { timeout: 610_000, signal });
    check(downloaded.code === 0, "CURSOR_CONTAINER_DOWNLOAD_FAILED");
    check(await hashFile(deb) === release.sha256, "CURSOR_CONTAINER_ARTIFACT_INTEGRITY");
    await copyFile(candidate, join(root, "candidate.tgz"));
    await copyFile(join(assets, "Dockerfile"), join(root, "Dockerfile"));
    await copyFile(join(assets, "seccomp-profile.json"), join(root, "seccomp-profile.json"));
    check(await hashFile(join(root, "seccomp-profile.json")) === provenance.seccomp.sha256, "CURSOR_CONTAINER_SECCOMP");
    await mkdir(join(root, "check"));
    for (const name of ["cursor-app-native-check.mjs", "cursor-app-protocol.mjs", "cursor-app-mock-server.mjs", "cursor-app-native-content-check.mjs"]) {
      await regularFile(join(scripts, name));
      await copyFile(join(scripts, name), join(root, "check", name));
    }
    report.stage = "container-build";
    dockerStarted = true;
    await checked(["build", "--label", `${label}=${runId}`, "--tag", names.image,
      "--build-arg", `CURSOR_DEB_VERSION=${release.debVersion}`, "--file", join(root, "Dockerfile"), root], { timeout: 20 * 60_000, signal });
    report.stage = "container-create";
    const imageId = await checked(["image", "inspect", "--format", "{{.Id}}", names.image], { signal });
    check(imagePattern.test(imageId), "CURSOR_CONTAINER_IDENTITY");
    await checked(["volume", "create", "--label", `${label}=${runId}`, names.volume], { signal });
    const containerId = await checked(makeContainerArgs({ runId, imageId, seccompPath: join(root, "seccomp-profile.json") }), { signal });
    check(/^[a-f0-9]{64}$/.test(containerId), "CURSOR_CONTAINER_IDENTITY");
    report.stage = "container-native";
    const started = await runDocker(["start", "--attach", containerId], { timeout: 10 * 60_000, signal });
    const state = JSON.parse(await checked(["container", "inspect", "--format", "{{json .State}}", containerId], { signal }));
    check(state.Running === false && Number.isInteger(state.ExitCode), "CURSOR_CONTAINER_STATE");
    await checked(["cp", `${containerId}:/artifacts/report.json`, join(root, "native-report.json")], { signal });
    const reportFile = await regularFile(join(root, "native-report.json"));
    check(reportFile.size <= 64 * 1024, "CURSOR_CONTAINER_REPORT");
    report = projectNativeReport(JSON.parse(await readFile(join(root, "native-report.json"), "utf8")));
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
    check(process.argv.length === 4, "CURSOR_CONTAINER_ARGUMENTS");
    const report = await runContainerCheck(process.argv[2], process.argv[3], { signal: abort.signal });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(safeCode(error));
    process.exitCode = 1;
  }
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { baselineRelease, resolveDownload } from "./cursor-app-release.mjs";

const executeFile = promisify(execFile);
const platform = "win32-x64-user";
const publisher = "Anysphere, Inc.";
const maxDownloadBytes = 600_000_000;
const maxCommandBytes = 4096;
const prefix = "CURSOR_APP_WINDOWS_ARTIFACT_";
const rootStages = ["PATH_SHAPE", "ITEM", "IDENTITY", "NOT_EMPTY", "ACL_SET", "ACL_READ", "PROTECTION",
  "OWNER", "RULE_COUNT", "RULE_SHAPE"];
const helperPath = fileURLToPath(new URL("./cursor-app-windows-authenticode.ps1", import.meta.url));

function failure(suffix) {
  const code = prefix + suffix;
  return Object.assign(new Error(code), { code });
}
function check(value, suffix) { if (!value) throw failure(suffix); }
function checkAborted(signal) { check(!signal?.aborted, "ABORTED"); }

function validateRelease(input, channel) {
  try {
    check(input?.platform === platform && input.channel === channel && ["baseline", "latest"].includes(channel), "RELEASE");
    const canonical = channel === "baseline" ? baselineRelease(platform)
      : resolveDownload(platform, { version: input.version, commitSha: input.commitSha, downloadUrl: input.url });
    check(Object.keys(canonical).every((key) => input[key] === canonical[key]), "RELEASE");
    return canonical;
  } catch { throw failure("RELEASE"); }
}

export function selectCursorWindowsRelease(manifest, channel) {
  check(manifest?.schemaVersion === 1 && ["baseline", "latest"].includes(channel), "RELEASE");
  return validateRelease(manifest[channel]?.[platform], channel);
}

async function download(release, path, fetchImpl, signal) {
  const controller = new AbortController();
  const downloadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]);
  let file;
  try {
    checkAborted(signal);
    const response = await fetchImpl(release.url, { credentials: "omit", redirect: "error", cache: "no-store",
      headers: { "User-Agent": "memorax-cursor-app-ci" }, signal: downloadSignal });
    check(response?.status === 200 && response.body && response.redirected === false && response.url === release.url, "DOWNLOAD");
    const length = response.headers.get("content-length");
    const expectedBytes = length === null ? undefined : Number(length);
    check(length === null || (/^[1-9]\d*$/.test(length) && Number.isSafeInteger(expectedBytes)
      && expectedBytes <= maxDownloadBytes), "DOWNLOAD_SIZE");
    file = await open(path, "wx", 0o600);
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of response.body) {
      checkAborted(downloadSignal);
      check(chunk instanceof Uint8Array, "DOWNLOAD");
      bytes += chunk.byteLength;
      check(bytes <= maxDownloadBytes, "DOWNLOAD_SIZE");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    check(bytes > 0 && (expectedBytes === undefined || bytes === expectedBytes), "DOWNLOAD_SIZE");
    checkAborted(downloadSignal);
    return { bytes, observedSha256: hash.digest("hex") };
  } catch (error) {
    if (signal?.aborted) throw failure("ABORTED");
    if (error?.code === prefix + "DOWNLOAD_SIZE") throw error;
    throw failure("DOWNLOAD");
  } finally {
    controller.abort();
    await file?.close();
  }
}

function outputJson(stdout) {
  check(typeof stdout === "string" && Buffer.byteLength(stdout) <= maxCommandBytes, "HELPER_OUTPUT");
  const value = JSON.parse(stdout);
  check(value && typeof value === "object" && !Array.isArray(value), "HELPER_OUTPUT");
  return value;
}

async function runHelper(execute, operation, payloadRoot, runtimeRoot, signal) {
  const phase = operation.toUpperCase();
  const suffix = "HELPER_" + phase;
  const powershellHome = "C:\\Program Files\\PowerShell\\7";
  const systemRoot = "C:\\Windows";
  let primaryError, childClosed, requiresClose = false, processingOutput = false;
  try {
    checkAborted(signal);
    requiresClose = execute === executeFile;
    const pending = execute(win32.join(powershellHome, "pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath,
      "-Operation", operation, "-Directory", payloadRoot], { cwd: runtimeRoot, signal, timeout: 120_000,
      maxBuffer: maxCommandBytes, encoding: "utf8", windowsHide: true, killSignal: "SIGKILL",
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: win32.join(systemRoot, "System32", "cmd.exe"),
        ProgramFiles: "C:\\Program Files", PATH: `${powershellHome};${systemRoot}\\System32`,
        PSModulePath: win32.join(powershellHome, "Modules"), HOME: runtimeRoot, USERPROFILE: runtimeRoot,
        APPDATA: join(runtimeRoot, "AppData", "Roaming"), LOCALAPPDATA: join(runtimeRoot, "AppData", "Local"),
        TEMP: runtimeRoot, TMP: runtimeRoot } });
    if (pending?.child) {
      requiresClose = true;
      childClosed = new Promise((resolve) => pending.child.once("close", () => resolve(true)));
    }
    const result = await pending;
    processingOutput = true;
    check(result && (result.code === undefined || result.code === 0) && result.stderr === "", suffix);
    const value = outputJson(result.stdout);
    const expected = operation === "prepare" ? { status: "PASS", operation, privateDirectory: true }
      : { status: "PASS", operation, authenticodeVerified: true, publisherVerified: true };
    check(Object.keys(value).length === Object.keys(expected).length
      && Object.keys(expected).every((key) => value[key] === expected[key]), suffix);
  } catch (error) {
    const timedOut = error?.code === "ETIMEDOUT"
      || (error?.killed === true && error.signal === "SIGKILL" && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    primaryError = failure(signal?.aborted ? "ABORTED" : timedOut ? suffix + "_TIMEOUT"
      : processingOutput || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? suffix + "_OUTPUT"
      : typeof error?.syscall === "string" && /^spawn(?: |$)/.test(error.syscall) ? suffix + "_SPAWN" : suffix + "_EXIT");
    if (!signal?.aborted && !timedOut && Number.isInteger(error?.code) && error.code !== 0 && error.stderr === "") {
      try {
        const value = outputJson(error.stdout);
        if (Object.keys(value).length === 2 && value.status === "FAIL") {
          const rootStage = rootStages.find((stage) => value.errorCode === prefix + "ROOT_" + stage);
          if (rootStage) primaryError = failure(`ROOT_${phase}_${rootStage}`);
          else if (value.errorCode === prefix + "PLATFORM"
            || (operation === "verify" && [prefix + "SIGNATURE", prefix + "PUBLISHER"].includes(value.errorCode))) {
            primaryError = failure(value.errorCode.slice(prefix.length));
          }
        }
      } catch { /* Only the helper's fixed diagnostic schema is accepted. */ }
    }
  }
  if (requiresClose) {
    let timer;
    const closed = childClosed && await Promise.race([childClosed, new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    })]);
    clearTimeout(timer);
    if (!closed) {
      primaryError ??= failure("PROCESS_CLEANUP");
      primaryError.cleanupErrorCode = prefix + "PROCESS_CLEANUP";
    }
  }
  if (primaryError) throw primaryError;
}

async function fingerprint(path, expected, signal) {
  let file;
  try {
    checkAborted(signal);
    const stat = await lstat(path);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size === expected.bytes && await realpath(path) === path, "CHANGED");
    file = await open(path, "r");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      checkAborted(signal);
      bytes += chunk.byteLength;
      check(bytes <= expected.bytes, "CHANGED");
      hash.update(chunk);
    }
    check(bytes === expected.bytes && hash.digest("hex") === expected.observedSha256, "CHANGED");
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    if (signal?.aborted) throw failure("ABORTED");
    throw failure("CHANGED");
  } finally { await file?.close(); }
}

export async function verifyCursorWindowsInstaller({ release, root, signal, execute = executeFile, fetchImpl = fetch,
  platform: hostPlatform = process.platform } = {}) {
  check(hostPlatform === "win32", "PLATFORM");
  check(typeof execute === "function" && typeof fetchImpl === "function" && typeof root === "string"
    && isAbsolute(root) && !/[\0\r\n]/.test(root), "ARGUMENTS");
  const selected = validateRelease(release, release?.channel);
  checkAborted(signal);
  let ownedRoot, rootStage = "ROOT_ITEM";
  try {
    const stat = await lstat(root);
    check(stat.isDirectory() && !stat.isSymbolicLink(), rootStage);
    rootStage = "ROOT_RESOLVE";
    const canonicalRoot = await realpath(root);
    rootStage = "ROOT_CREATE";
    ownedRoot = await mkdtemp(join(canonicalRoot, "cursor-windows-artifact-"));
  } catch { throw failure(rootStage); }
  let primaryError, cleanupError, artifact;
  try {
    const payloadRoot = join(ownedRoot, "payload");
    const runtimeRoot = join(ownedRoot, "runtime");
    try {
      await mkdir(payloadRoot, { mode: 0o700 });
      await mkdir(runtimeRoot, { mode: 0o700 });
    } catch { throw failure("ROOT_CREATE"); }
    await runHelper(execute, "prepare", payloadRoot, runtimeRoot, signal);
    const installerPath = join(payloadRoot, "CursorUserSetup.exe");
    artifact = await download(selected, installerPath, fetchImpl, signal);
    const before = await fingerprint(installerPath, artifact, signal);
    await runHelper(execute, "verify", payloadRoot, runtimeRoot, signal);
    const after = await fingerprint(installerPath, artifact, signal);
    check(before.dev === after.dev && before.ino === after.ino, "CHANGED");
    checkAborted(signal);
  } catch (error) {
    primaryError = typeof error?.code === "string" && error.code.startsWith(prefix) && error.message === error.code
      ? error : failure("VALIDATION");
  } finally {
    if (primaryError?.cleanupErrorCode === prefix + "PROCESS_CLEANUP") cleanupError = failure("PROCESS_CLEANUP");
    else {
      try {
        await rm(ownedRoot, { recursive: true, force: true });
        try { await lstat(ownedRoot); throw failure("CLEANUP"); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      } catch { cleanupError = failure("CLEANUP"); }
    }
  }
  if (!primaryError && signal?.aborted) primaryError = failure("ABORTED");
  if (cleanupError) {
    (primaryError ?? cleanupError).cleanupErrorCode = cleanupError.code;
  }
  if (primaryError || cleanupError) throw primaryError ?? cleanupError;
  return Object.freeze({ platform, channel: selected.channel, version: selected.version, commitSha: selected.commitSha,
    sha256: null, hashSource: "not-provided", ...artifact, authenticodeVerified: true, publisherVerified: true,
    signatureType: "Authenticode", publisher, installerExecuted: false, appIdentityVerified: false,
    appArchitectureVerified: false, ownedFilesRemoved: true });
}

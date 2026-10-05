import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import { baselineRelease, resolveDownload } from "./cursor-app-release.mjs";

const executeFile = promisify(execFile);
const platform = "darwin-arm64";
const bundleIdentifier = "com.todesktop.230313mzl4w4u92";
const teamIdentifier = "VDXQ22DGB9";
const signatureRequirement = `=identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;
const maxDownloadBytes = 600_000_000;
const maxMetadataBytes = 1024 * 1024;
const codePrefix = "CURSOR_APP_MACOS_ARTIFACT_";
const detachStderrClasses = new Map([
  ["hdiutil: detach failed - Resource busy", "resource-busy"],
  ["hdiutil: detach failed - Operation not permitted", "operation-not-permitted"],
  ["hdiutil: detach failed - Permission denied", "permission-denied"],
  ["hdiutil: detach failed - No such file or directory", "missing-target"],
]);

function failure(suffix) {
  const code = codePrefix + suffix;
  return Object.assign(new Error(code), { code });
}
function check(value, suffix) { if (!value) throw failure(suffix); }
function checkAborted(signal) { check(!signal?.aborted, "ABORTED"); }

export function projectCursorMacosDetachDiagnostics(value) {
  return {
    exitCode: Number.isInteger(value?.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 ? value.exitCode : null,
    signal: value?.signal == null ? "none"
      : ["none", "SIGABRT", "SIGBUS", "SIGILL", "SIGKILL", "SIGSEGV", "SIGTERM", "SIGTRAP"].includes(value.signal) ? value.signal : "other",
    timedOut: value?.timedOut === true, outputOverflow: value?.outputOverflow === true,
    stderrClass: value?.stderrClass === undefined ? "absent"
      : [...detachStderrClasses.values(), "absent", "other"].includes(value.stderrClass) ? value.stderrClass : "other",
  };
}

function detachDiagnostics(error, result, timedOut) {
  const stderr = error?.stderr ?? result?.stderr;
  let stderrClass = stderr === undefined || stderr === "" ? "absent" : "other";
  if (typeof stderr === "string" && Buffer.byteLength(stderr) <= 4096) {
    const matches = new Set(stderr.split(/\r?\n/).map((line) => detachStderrClasses.get(line)).filter(Boolean));
    if (matches.size === 1) stderrClass = [...matches][0];
  }
  return projectCursorMacosDetachDiagnostics({ exitCode: typeof error?.code === "number" ? error.code : result?.code,
    signal: error?.signal ?? result?.signal, timedOut, outputOverflow: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderrClass });
}

function validateRelease(input, channel) {
  try {
    check(input?.platform === platform && input.channel === channel && ["baseline", "latest"].includes(channel), "RELEASE");
    const canonical = channel === "baseline" ? baselineRelease(platform)
      : resolveDownload(platform, { version: input.version, commitSha: input.commitSha, downloadUrl: input.url });
    check(Object.keys(canonical).every((key) => input[key] === canonical[key]), "RELEASE");
    return canonical;
  } catch { throw failure("RELEASE"); }
}

export function selectCursorMacosRelease(manifest, channel) {
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
    const lengthHeader = response.headers.get("content-length");
    const expectedBytes = lengthHeader === null ? undefined : Number(lengthHeader);
    check(lengthHeader === null || (/^[1-9]\d*$/.test(lengthHeader) && Number.isSafeInteger(expectedBytes)
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
    if (error?.code === codePrefix + "DOWNLOAD_SIZE") throw error;
    throw failure("DOWNLOAD");
  } finally {
    controller.abort();
    await file?.close();
  }
}

async function command(execute, file, args, options, suffix) {
  let result;
  try {
    checkAborted(options.signal);
    result = await execute(file, args, { timeout: 120_000, maxBuffer: maxMetadataBytes, encoding: "utf8",
      killSignal: "SIGKILL", ...options });
    check(result && (result.code === undefined || result.code === 0) && typeof result.stdout === "string"
      && Buffer.byteLength(result.stdout) <= maxMetadataBytes, suffix);
    return result.stdout;
  } catch (error) {
    if (options.signal?.aborted) throw failure("ABORTED");
    const timedOut = error?.code === "ETIMEDOUT" || (error?.killed === true && error.signal === "SIGKILL"
      && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    const caught = failure(timedOut ? suffix + "_TIMEOUT" : suffix);
    if (suffix === "DETACH") caught.artifactDetach = detachDiagnostics(error, result, timedOut);
    throw caught;
  }
}

function json(text, suffix) {
  try {
    const result = JSON.parse(text);
    check(result && typeof result === "object" && !Array.isArray(result), suffix);
    return result;
  } catch { throw failure(suffix); }
}

async function containedFile(appPath, path, suffix, maximum = maxMetadataBytes) {
  try {
    const resolved = await realpath(path);
    const stat = await lstat(path);
    check(resolved.startsWith(appPath + sep) && !stat.isSymbolicLink() && stat.isFile()
      && stat.size > 0 && stat.size <= maximum, suffix);
    return path;
  } catch { throw failure(suffix); }
}

async function validateApp(appPath, release, execute, options) {
  try {
    const stat = await lstat(appPath);
    check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(appPath) === appPath, "PACKAGE");
  } catch { throw failure("PACKAGE"); }
  await command(execute, "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", appPath], options, "SIGNATURE");
  await command(execute, "/usr/bin/codesign", ["--verify", "--strict", "--all-architectures",
    "--test-requirement", signatureRequirement, appPath], options, "IDENTITY");
  await command(execute, "/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], options, "ASSESSMENT");
  const infoPath = await containedFile(appPath, join(appPath, "Contents/Info.plist"), "PACKAGE");
  const info = json(await command(execute, "/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], options, "PACKAGE"), "PACKAGE");
  const packagePath = await containedFile(appPath, join(appPath, "Contents/Resources/app/package.json"), "PACKAGE");
  const productPath = await containedFile(appPath, join(appPath, "Contents/Resources/app/product.json"), "PACKAGE");
  let packageJson, productJson;
  try {
    packageJson = json(await readFile(packagePath, "utf8"), "PACKAGE");
    productJson = json(await readFile(productPath, "utf8"), "PACKAGE");
  } catch { throw failure("PACKAGE"); }
  check(info.CFBundleIdentifier === bundleIdentifier && info.CFBundleExecutable === "Cursor"
    && info.CFBundleShortVersionString === release.version && packageJson.version === release.version
    && productJson.version === release.version && productJson.realCommit === release.commitSha
    && productJson.darwinBundleIdentifier === bundleIdentifier, "PACKAGE");
  const executablePath = await containedFile(appPath, join(appPath, "Contents/MacOS/Cursor"), "ARCHITECTURE", maxDownloadBytes);
  let executable;
  try {
    executable = await open(executablePath, "r");
    const header = Buffer.alloc(32);
    const { bytesRead } = await executable.read(header, 0, header.length, 0);
    check(bytesRead === header.length && header.readUInt32LE(0) === 0xfeedfacf
      && header.readUInt32LE(4) === 0x0100000c && header.readUInt32LE(12) === 2
      && ((await executable.stat()).mode & 0o111) !== 0, "ARCHITECTURE");
  } catch { throw failure("ARCHITECTURE"); }
  finally { await executable?.close(); }
}

export async function withCursorMacosApp({ release, root, signal, execute = executeFile, fetchImpl = fetch,
  platform: hostPlatform = process.platform } = {}, callback) {
  check(hostPlatform === "darwin", "PLATFORM");
  check(typeof callback === "function" && typeof execute === "function" && typeof fetchImpl === "function"
    && typeof root === "string" && isAbsolute(root) && !/[\0\r\n]/.test(root), "ARGUMENTS");
  const selected = validateRelease(release, release?.channel);
  checkAborted(signal);
  let ownedRoot;
  try {
    const stat = await lstat(root);
    check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), "ROOT");
    ownedRoot = await mkdtemp(join(await realpath(root), "cursor-artifact-"));
  } catch { throw failure("ROOT"); }
  const mountpoint = join(ownedRoot, "mounted");
  const imagePath = join(ownedRoot, "Cursor.dmg");
  const options = { cwd: ownedRoot, signal, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: ownedRoot,
    CFFIXED_USER_HOME: ownedRoot, TMPDIR: ownedRoot, TMP: ownedRoot, TEMP: ownedRoot, LANG: "C", LC_ALL: "C" } };
  let attachAttempted = false, detachAttempted = false, invokingCallback = false, primaryError, cleanupError, value;
  const detach = async () => {
    detachAttempted = true;
    try {
      // Cleanup remains bounded even when acquisition or the callback was aborted.
      await command(execute, "/usr/bin/hdiutil", ["detach", mountpoint], { ...options, signal: undefined, timeout: 30_000 }, "DETACH");
    } catch (error) { cleanupError = error; throw error; }
  };
  try {
    const artifact = await download(selected, imagePath, fetchImpl, signal);
    await mkdir(mountpoint, { mode: 0o700 });
    attachAttempted = true;
    const plist = await command(execute, "/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen",
      "-mountpoint", mountpoint, "-plist", imagePath], options, "MOUNT");
    const mountMetadata = join(ownedRoot, "mount.plist");
    await writeFile(mountMetadata, plist, { flag: "wx", mode: 0o600 });
    const mounted = json(await command(execute, "/usr/bin/plutil", ["-convert", "json", "-o", "-", mountMetadata],
      options, "MOUNT_METADATA"), "MOUNT_METADATA");
    check(Array.isArray(mounted["system-entities"]), "MOUNT_METADATA");
    const volumes = mounted["system-entities"].filter((entry) => entry?.["mount-point"] !== undefined);
    check(volumes.length === 1 && volumes[0]["mount-point"] === mountpoint, "MOUNT_METADATA");
    const mountedBundle = join(mountpoint, "Cursor.app");
    await validateApp(mountedBundle, selected, execute, options);
    const bundlePath = join(ownedRoot, "Cursor.app");
    await command(execute, "/usr/bin/ditto", [mountedBundle, bundlePath], options, "COPY");
    await validateApp(bundlePath, selected, execute, options);
    await detach();
    checkAborted(signal);
    const evidence = Object.freeze({ platform, channel: selected.channel, version: selected.version, commitSha: selected.commitSha,
      sha256: null, hashSource: "not-provided", ...artifact, architecture: "arm64", readOnlyMount: true,
      copiedBundleVerified: true, imageDetachedBeforeLaunch: true,
      signatureVerified: true, bundleIdentifier, teamIdentifier, gatekeeperAccepted: true, packageIdentityVerified: true });
    invokingCallback = true;
    value = await callback({ appPath: join(bundlePath, "Contents/MacOS/Cursor"), evidence });
    checkAborted(signal);
  } catch (error) {
    primaryError = error instanceof Error && (invokingCallback
      || (typeof error.code === "string" && error.code.startsWith(codePrefix) && error.message === error.code)) ? error : failure("VALIDATION");
  } finally {
    if (attachAttempted && !detachAttempted) {
      try { await detach(); } catch { /* The original error and cleanup diagnostic are retained separately. */ }
    }
    // A failed callback may still own live App processes. The outer controller
    // removes its root only after independently verifying native cleanup.
    if (!cleanupError && !(invokingCallback && primaryError)) {
      try { await rm(ownedRoot, { recursive: true, force: true }); }
      catch { cleanupError = failure("CLEANUP"); }
    }
  }
  if (cleanupError) cleanupError.cleanupErrorCode = cleanupError.code;
  if (primaryError) {
    if (cleanupError) {
      primaryError.cleanupErrorCode = cleanupError.code;
      if (cleanupError.artifactDetach) primaryError.artifactDetach = cleanupError.artifactDetach;
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return value;
}

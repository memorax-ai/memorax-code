import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const metadataLimit = 1024 * 1024;
const aptRoot = "https://downloads.cursor.com/aptrepo/dists/stable";
// Official key: https://downloads.cursor.com/keys/anysphere.asc (verified 2026-10-05).
// The pinned fingerprint is Anysphere Inc's primary signing key, not an inferred package hash.
const fingerprint = "380FF4BCDC34A4BD92A3565342A1772E62E492D6";
const keySha256 = "9d2adcc95efdf65e6e76f964968734551ab70181634781f9d5952b271895ec03";
const keyFile = new URL("../../fixtures/cursor-app/anysphere.asc", import.meta.url);
const architectures = { "linux-x64": "amd64", "linux-arm64": "arm64" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(value, code) { if (!value) fail(code); }
function decode(bytes) { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }

export async function verifyCursorAptSignature(inRelease, { run = exec } = {}) {
  let root;
  try {
    check(Buffer.isBuffer(inRelease) && inRelease.length > 0 && inRelease.length <= metadataLimit);
    const keyInfo = await lstat(keyFile);
    check(keyInfo.isFile() && !keyInfo.isSymbolicLink() && keyInfo.size <= 8192);
    const key = await readFile(keyFile);
    check(sha256(key) === keySha256);
    root = await mkdtemp(join(tmpdir(), "memorax-cursor-apt-"));
    await writeFile(join(root, "key.asc"), key, { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "InRelease"), inRelease, { flag: "wx", mode: 0o600 });
    const options = { timeout: 15_000, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true,
      env: { PATH: process.env.PATH, HOME: root, GNUPGHOME: root, LANG: "C", LC_ALL: "C" } };
    await run("gpg", ["--no-options", "--batch", "--homedir", root, "--dearmor", "--output", join(root, "keyring.gpg"), join(root, "key.asc")], options);
    const { stdout } = await run("gpgv", ["--homedir", root, "--status-fd", "1", "--keyring", join(root, "keyring.gpg"),
      "--output", join(root, "Release"), join(root, "InRelease")], options);
    const statuses = stdout.trim().split(/\r?\n/);
    check(!statuses.some((line) => /^\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|KEYEXPIRED|SIGEXPIRED|NO_PUBKEY|FAILURE|ERROR)\b/.test(line)));
    const signatures = statuses.filter((line) => line.startsWith("[GNUPG:] VALIDSIG ")).map((line) => line.split(/\s+/));
    check(signatures.length === 1 && signatures[0].length === 12 && signatures[0][2] === fingerprint
      && signatures[0][11] === fingerprint && ["8", "9", "10"].includes(signatures[0][9]));
    const verified = await readFile(join(root, "Release"));
    check(verified.length > 0 && verified.length <= metadataLimit);
    return decode(verified);
  } catch { fail("CURSOR_RELEASE_APT_SIGNATURE_FAILED"); }
  finally {
    if (root) try { await rm(root, { recursive: true, force: true }); }
    catch { fail("CURSOR_RELEASE_APT_CLEANUP_FAILED"); }
  }
}

// Debian control files use case-insensitive fields and space-prefixed continuations.
function parseControl(text) {
  check(typeof text === "string" && !text.includes("\0"));
  const paragraphs = [];
  let fields = Object.create(null), previous;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    check(!line.includes("\r"));
    if (line === "") {
      if (Object.keys(fields).length) paragraphs.push(fields);
      fields = Object.create(null); previous = undefined;
    } else if (/^[ \t]/.test(line)) {
      check(previous);
      fields[previous] += "\n" + line.slice(1);
    } else {
      const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
      check(match);
      previous = match[1].toLowerCase();
      check(!Object.hasOwn(fields, previous));
      fields[previous] = match[2];
    }
  }
  if (Object.keys(fields).length) paragraphs.push(fields);
  return paragraphs;
}

function packageIndexes(text) {
  try {
    const paragraphs = parseControl(text);
    check(paragraphs.length === 1);
    const release = paragraphs[0];
    check(release.codename === "stable" && release.components?.split(/\s+/).includes("main")
      && Object.values(architectures).every((arch) => release.architectures?.split(/\s+/).includes(arch)));
    check(typeof release.sha256 === "string");
    const rows = release.sha256.trim().split("\n").map((line) => line.trim().split(/\s+/));
    check(rows.every(([hash, size, path, extra]) => typeof hash === "string" && hash.length === 64 && digestPattern.test(hash)
      && /^[1-9]\d*$/.test(size) && Number.isSafeInteger(Number(size)) && path && !extra));
    return Object.fromEntries(Object.values(architectures).map((arch) => {
      const path = `main/binary-${arch}/Packages`, matching = rows.filter((row) => row[2] === path);
      check(matching.length === 1 && Number(matching[0][1]) <= metadataLimit);
      return [arch, { path, sha256: matching[0][0], size: Number(matching[0][1]) }];
    }));
  } catch { fail("CURSOR_RELEASE_APT_INDEX_INVALID"); }
}

function packageRelease(descriptor, bytes, arch) {
  try {
    const candidates = parseControl(decode(bytes)).filter((item) => item.package === "cursor" && item.architecture === arch
      && item.version?.startsWith(descriptor.version + "-"));
    check(candidates.length === 1);
    const item = candidates[0], revision = item.version.slice(descriptor.version.length + 1);
    check(revision === revision.trim() && /^[1-9]\d*$/.test(revision) && Number.isSafeInteger(Number(revision)));
    check(item.filename === `pool/stable/c/cu/cursor_${descriptor.version}_${arch}.deb`);
    check(typeof item.sha256 === "string" && item.sha256.length === 64 && digestPattern.test(item.sha256));
    check(/^[1-9]\d*$/.test(item.size) && Number.isSafeInteger(Number(item.size)) && Number(item.size) <= 300_000_000);
    const { platform, version, commitSha, url, channel } = descriptor;
    return Object.freeze({ platform, version, commitSha, url, channel, sha256: item.sha256,
      hashSource: "official-apt-sha256", debVersion: item.version, size: Number(item.size) });
  } catch { fail("CURSOR_RELEASE_APT_PACKAGE_INVALID"); }
}

async function fetchAptBytes(url) {
  const response = await fetch(url, { headers: { "User-Agent": "memorax-cursor-app-ci" }, credentials: "omit",
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  check(response.ok && response.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= metadataLimit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function verifyLinuxAptReleases(descriptors, { fetchBytes = fetchAptBytes, verifySignature = verifyCursorAptSignature } = {}) {
  for (const [platform, arch] of Object.entries(architectures)) {
    const input = descriptors?.[platform], downloadArch = arch === "amd64" ? "x64" : "arm64";
    check(input?.platform === platform && input.channel === "latest" && typeof input.version === "string"
      && input.version === input.version.trim() && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version)
      && typeof input.commitSha === "string" && input.commitSha.length === 40 && /^[a-f0-9]{40}$/.test(input.commitSha)
      && input.url === `https://downloads.cursor.com/production/${input.commitSha}/linux/${downloadArch}/deb/${arch}/deb/cursor_${input.version}_${arch}.deb`,
    "CURSOR_RELEASE_APT_DESCRIPTOR_INVALID");
  }
  const read = async (path) => {
    try {
      const bytes = await fetchBytes(`${aptRoot}/${path}`);
      check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= metadataLimit);
      return bytes;
    } catch { fail("CURSOR_RELEASE_APT_FETCH_FAILED"); }
  };
  const signed = await read("InRelease");
  let text;
  try { text = await verifySignature(signed); }
  catch { fail("CURSOR_RELEASE_APT_SIGNATURE_FAILED"); }
  const indexes = packageIndexes(text), verified = {};
  for (const [platform, arch] of Object.entries(architectures)) {
    const expected = indexes[arch], bytes = await read(expected.path);
    check(bytes.length === expected.size && sha256(bytes) === expected.sha256, "CURSOR_RELEASE_APT_PACKAGES_INTEGRITY");
    verified[platform] = packageRelease(descriptors[platform], bytes, arch);
  }
  return Object.freeze(verified);
}

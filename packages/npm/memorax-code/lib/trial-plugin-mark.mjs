import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  hostname as readHostname,
  networkInterfaces,
  platform as readPlatform,
} from "node:os";
import { spawnSync } from "node:child_process";

const COMMAND_TIMEOUT_MS = 1_000;
export const TRIAL_MARK_VERSION = 1;
export const TRIAL_APP_SALT = "memorax-plugin-v1";

export function generateTrialPluginIdentity() {
  const platform = normalizePlatform(safely(readPlatform));
  return deriveTrialPluginIdentity({
    markVersion: TRIAL_MARK_VERSION,
    appSalt: TRIAL_APP_SALT,
    machineId: readMachineId(platform),
    hostname: safely(readHostname),
    platform,
    arch: process.arch,
    macHash: createTrialMacHash(flattenNetworkInterfaces()),
  });
}

export function generateTrialMarkId() {
  return generateTrialPluginIdentity().markId;
}

export function deriveTrialPluginIdentity(fields = {}) {
  const identity = Object.freeze({
    markVersion: fields.markVersion ?? TRIAL_MARK_VERSION,
    appSalt: normalizeAppSalt(fields.appSalt),
    machineId: trimmed(fields.machineId),
    hostname: trimmed(fields.hostname),
    platform: normalizePlatform(fields.platform),
    arch: normalizeArch(fields.arch),
    macHash: normalize(fields.macHash),
  });
  const material = [
    identity.appSalt,
    hashMachineId(identity.machineId),
    identity.hostname,
    identity.platform,
    identity.arch,
    identity.macHash,
  ].join("");
  return Object.freeze({
    ...identity,
    markId: `mk_${sha256Hex(material)}`,
  });
}

export function deriveTrialMarkId(fields = {}) {
  return deriveTrialPluginIdentity(fields).markId;
}

export function createTrialMacHash(entries = []) {
  const macs = [...new Set(entries
    .filter((entry) => entry?.internal === false)
    .map((entry) => normalizeMac(entry?.mac))
    .filter(Boolean))]
    .sort();
  return sha256Hex(macs.join(""));
}

function readMachineId(platform) {
  if (platform === "linux") {
    return readFirstFile(["/etc/machine-id", "/var/lib/dbus/machine-id"]);
  }
  if (platform === "macos") {
    const output = runCommand("/usr/sbin/ioreg", [
      "-rd1",
      "-c",
      "IOPlatformExpertDevice",
    ]);
    return output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i)?.[1] ?? "";
  }
  if (platform === "windows") {
    const output = runCommand("reg.exe", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    return output.match(/^\s*MachineGuid\s+REG_\w+\s+(.+?)\s*$/im)?.[1] ?? "";
  }
  return "";
}

function readFirstFile(paths) {
  for (const path of paths) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next standard machine ID location.
    }
  }
  return "";
}

function runCommand(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.status === 0 && typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return "";
  }
}

function flattenNetworkInterfaces() {
  const groups = safely(networkInterfaces);
  if (!groups || typeof groups !== "object") return [];
  return Object.values(groups).flatMap((entries) => Array.isArray(entries) ? entries : []);
}

function normalizeMac(value) {
  const normalized = normalize(value);
  if (!/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(normalized)) return "";
  const compact = normalized.replaceAll(":", "").replaceAll("-", "");
  return compact === "000000000000" ? "" : compact;
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAppSalt(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePlatform(value) {
  const platform = normalize(value);
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "win32" || platform === "windows") return "windows";
  return platform;
}

function normalizeArch(value) {
  const arch = normalize(value);
  return arch === "x64" ? "x86_64" : arch;
}

function hashMachineId(value) {
  return sha256Hex(normalize(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safely(operation) {
  try {
    return operation();
  } catch {
    return "";
  }
}

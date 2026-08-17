import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  hostname as readHostname,
  networkInterfaces,
  platform as readPlatform,
} from "node:os";
import { spawnSync } from "node:child_process";

const COMMAND_TIMEOUT_MS = 1_000;

export function generateTrialPluginIdentity() {
  const platform = normalize(safely(readPlatform));
  return deriveTrialPluginIdentity({
    appSalt: readAppSalt(),
    machineId: readMachineId(platform),
    hostname: safely(readHostname),
    platform,
    arch: process.arch,
    macHash: createTrialMacHash(flattenNetworkInterfaces()),
  });
}

export function generateTrialPluginMark() {
  return generateTrialPluginIdentity().pluginMark;
}

export function deriveTrialPluginIdentity(fields = {}) {
  const identity = Object.freeze({
    appSalt: normalizeAppSalt(fields.appSalt),
    machineIdHash: hashMachineId(fields.machineId),
    hostname: normalize(fields.hostname),
    platform: normalize(fields.platform),
    arch: normalize(fields.arch),
    macHash: normalize(fields.macHash),
  });
  const material = [
    identity.appSalt,
    identity.machineIdHash,
    identity.hostname,
    identity.platform,
    identity.arch,
    identity.macHash,
  ].join("");
  return Object.freeze({
    ...identity,
    pluginMark: `mk_${sha256Hex(material).slice(0, 32)}`,
  });
}

export function deriveTrialPluginMark(fields = {}) {
  return deriveTrialPluginIdentity(fields).pluginMark;
}

export function createTrialMacHash(entries = []) {
  const macs = [...new Set(entries
    .filter((entry) => entry?.internal === false)
    .map((entry) => normalizeMac(entry?.mac))
    .filter(Boolean))]
    .sort();
  return macs.length === 0 ? "" : sha256Hex(macs.join(""));
}

function readAppSalt() {
  try {
    const metadata = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    ));
    if (typeof metadata?.name !== "string" || typeof metadata?.version !== "string") {
      return "";
    }
    return `${metadata.name.trim()}@${metadata.version.trim()}`;
  } catch {
    return "";
  }
}

function readMachineId(platform) {
  if (platform === "linux") {
    return readFirstFile(["/etc/machine-id", "/var/lib/dbus/machine-id"]);
  }
  if (platform === "darwin") {
    const output = runCommand("/usr/sbin/ioreg", [
      "-rd1",
      "-c",
      "IOPlatformExpertDevice",
    ]);
    return output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i)?.[1] ?? "";
  }
  if (platform === "win32") {
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

function normalizeAppSalt(value) {
  return typeof value === "string" ? value.trim() : "";
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

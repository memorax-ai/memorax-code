import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveNpmInvocation } from "./npm-invocation.mjs";

const WINDOWS_USER_PATH_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$globalBin = $env:MEMORAX_CODE_WINDOWS_NPM_GLOBAL_BIN

function Normalize-PathEntry([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return [Environment]::ExpandEnvironmentVariables(
        $Value.Trim().Trim('"')
    ).TrimEnd('\')
}

$normalizedGlobalBin = Normalize-PathEntry $globalBin
$changed = $false
$completed = $false

for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    })
    $present = @($entries | Where-Object {
        (Normalize-PathEntry $_) -ieq $normalizedGlobalBin
    }).Count -gt 0

    if ($present) {
        $completed = $true
        break
    }

    $separator = if ([string]::IsNullOrWhiteSpace($userPath) -or $userPath.TrimEnd().EndsWith(";")) { "" } else { ";" }
    $updatedPath = "$userPath$separator$globalBin"
    if ($updatedPath.Length -ge 32767) {
        throw "The updated user PATH would exceed the Windows environment limit."
    }

    $latestUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not [string]::Equals([string]$latestUserPath, [string]$userPath, [StringComparison]::Ordinal)) {
        continue
    }

    [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
    $changed = $true
    $writtenUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::Equals([string]$writtenUserPath, [string]$updatedPath, [StringComparison]::Ordinal)) {
        $completed = $true
        break
    }
}

if (-not $completed) {
    throw "The Windows user PATH changed concurrently; retry setup."
}

[Console]::Out.Write((@{ changed = $changed } | ConvertTo-Json -Compress))
`;

export function ensureWindowsNpmGlobalPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") return result("skipped", "unsupported_platform");

  let globalBin;
  try {
    globalBin = (options.resolveGlobalPrefix ?? resolveWindowsNpmGlobalPrefix)({
      ...options,
      env,
      platform,
    });
  } catch {
    return result("warning", "npm_prefix_unavailable");
  }
  if (typeof globalBin !== "string"
    || globalBin.includes(";")
    || !path.win32.isAbsolute(globalBin.trim())) {
    return result("warning", "npm_prefix_unavailable");
  }
  globalBin = path.win32.normalize(globalBin.trim());

  const fileExists = options.existsSync ?? existsSync;
  const requiredShims = ["memorax-code.cmd", "memorax-cli.cmd"];
  if (!requiredShims.every((name) => fileExists(path.win32.join(globalBin, name)))) {
    return result("warning", "global_shims_missing");
  }

  const pathKey = windowsPathKey(env);
  const currentPath = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const processPathChanged = !windowsPathContains(currentPath, globalBin, env);
  if (processPathChanged) {
    env[pathKey] = currentPath
      ? `${currentPath}${currentPath.trimEnd().endsWith(";") ? "" : ";"}${globalBin}`
      : globalBin;
  }

  let userPathChanged = false;
  try {
    const update = (options.updateUserPath ?? updateWindowsUserPath)(globalBin, {
      ...options,
      env,
      platform,
    });
    if (typeof update?.changed !== "boolean") throw new Error("invalid user PATH update result");
    userPathChanged = update.changed;
  } catch {
    return result("warning", "user_path_update_failed", {
      processPathChanged,
    });
  }

  const changed = processPathChanged || userPathChanged;
  return result(changed ? "updated" : "unchanged", undefined, {
    processPathChanged,
    userPathChanged,
    restartRecommended: changed,
  });
}

export function resolveWindowsNpmGlobalPrefix(options = {}) {
  const env = options.env ?? process.env;
  const invocation = resolveNpmInvocation(["prefix", "-g"], options);
  const run = options.spawnSync ?? spawnSync;
  const resolved = run(invocation.command, invocation.args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  });
  if (resolved.error || resolved.signal || resolved.status !== 0) {
    throw new Error("npm global prefix command failed");
  }
  const lines = String(resolved.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const prefix = lines.at(-1);
  if (!prefix || !path.win32.isAbsolute(prefix)) throw new Error("npm global prefix is invalid");
  return prefix;
}

export function updateWindowsUserPath(globalBin, options = {}) {
  const env = options.env ?? process.env;
  const run = options.spawnSync ?? spawnSync;
  const powerShell = windowsPowerShellCommand(env, options.existsSync ?? existsSync);
  const encodedCommand = Buffer.from(WINDOWS_USER_PATH_SCRIPT, "utf16le").toString("base64");
  const updated = run(powerShell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedCommand,
  ], {
    encoding: "utf8",
    env: { ...env, MEMORAX_CODE_WINDOWS_NPM_GLOBAL_BIN: globalBin },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  });
  if (updated.error || updated.signal || updated.status !== 0) {
    throw new Error("Windows user PATH update failed");
  }
  let parsed;
  try {
    parsed = JSON.parse(String(updated.stdout ?? "").trim());
  } catch {
    throw new Error("Windows user PATH update returned invalid output");
  }
  if (typeof parsed?.changed !== "boolean") {
    throw new Error("Windows user PATH update returned an invalid result");
  }
  return { changed: parsed.changed };
}

function windowsPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function windowsPathContains(pathValue, expected, env) {
  const normalizedExpected = normalizeWindowsPathEntry(expected, env);
  return String(pathValue ?? "").split(";").some((entry) => (
    normalizeWindowsPathEntry(entry, env) === normalizedExpected
  ));
}

function normalizeWindowsPathEntry(value, env) {
  const expanded = String(value ?? "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/%([^%]+)%/g, (match, name) => environmentValue(env, name) ?? match);
  if (!expanded) return "";
  return path.win32.normalize(expanded).replace(/[\\/]+$/, "").toLowerCase();
}

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function windowsPowerShellCommand(env, fileExists) {
  const systemRoot = environmentValue(env, "SystemRoot") ?? environmentValue(env, "WINDIR");
  if (systemRoot) {
    const candidate = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fileExists(candidate)) return candidate;
  }
  return "powershell.exe";
}

function result(status, reason, overrides = {}) {
  return {
    status,
    ...(reason ? { reason } : {}),
    processPathChanged: false,
    userPathChanged: false,
    restartRecommended: false,
    ...overrides,
  };
}

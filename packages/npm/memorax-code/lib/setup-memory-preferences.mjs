import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { win32 } from "node:path";

const COMMAND_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export function detectSetupMemoryPreferences(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const account = safely(options.readUserInfo ?? userInfo);
  const locale = systemLocale({
    platform,
    env,
    runCommand: options.runCommand ?? spawnSync,
    readIntlLocale: options.readIntlLocale ?? defaultIntlLocale,
  });
  return Object.freeze({
    userId: detectedUserId(account, platform),
    outputLanguage: memoryLanguage(locale),
  });
}

function detectedUserId(account, platform) {
  if (platform !== "win32" && account?.uid === 0) return undefined;
  const username = String(account?.username ?? "").normalize("NFKC").trim();
  if (!username || /[\0\r\n]/.test(username)) return undefined;
  return [...username].slice(0, 120).join("");
}

function systemLocale({ platform, env, runCommand, readIntlLocale }) {
  if (platform === "darwin") {
    return macosPreferredLanguage(runCommand, env)
      ?? environmentLocale(env)
      ?? safely(readIntlLocale);
  }
  if (platform === "win32") {
    return windowsUiLanguage(runCommand, env)
      ?? safely(readIntlLocale);
  }
  return environmentLocale(env) ?? safely(readIntlLocale);
}

function macosPreferredLanguage(runCommand, env) {
  const output = commandOutput(runCommand, "/usr/bin/defaults", [
    "read",
    "-g",
    "AppleLanguages",
  ], env);
  return /"([^"]+)"/.exec(output ?? "")?.[1];
}

function windowsUiLanguage(runCommand, env) {
  const systemRoot = nonEmpty(env.SystemRoot) ?? nonEmpty(env.SYSTEMROOT);
  const powershell = systemRoot
    ? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return commandOutput(runCommand, powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [System.Globalization.CultureInfo]::CurrentUICulture.Name",
  ], env);
}

function commandOutput(runCommand, command, args, env) {
  let result;
  try {
    result = runCommand(command, args, {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
  if (result?.status !== 0 || result.error || result.signal) return undefined;
  return nonEmpty(String(result.stdout ?? "").replace(/^\uFEFF/, ""));
}

function environmentLocale(env) {
  return nonEmpty(env.LC_ALL)
    ?? nonEmpty(env.LC_MESSAGES)
    ?? nonEmpty(env.LANGUAGE)?.split(":", 1)[0]
    ?? nonEmpty(env.LANG);
}

function defaultIntlLocale() {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function memoryLanguage(value) {
  const locale = nonEmpty(value)?.toLowerCase().replaceAll("_", "-");
  if (!locale) return undefined;
  return /^zh(?:-|$)/.test(locale) ? "zh" : "en";
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function safely(operation) {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

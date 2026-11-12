import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";

const APP_NAMES = ["WorkBuddy.app", "CodeBuddy.app"];
const BUNDLED_SEGMENTS = ["Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy"];
const WINDOWS_SEGMENTS = [
  ["resources", "app.asar.unpacked", "cli", "bin", "codebuddy"],
  ["resources", "app.asar.unpacked", "cli", "bin", "codebuddy.exe"],
];

export function defaultCodeBuddyHome(env = process.env, homeDir = homedir(), platform = process.platform) {
  const configured = stringValue(env.CODEBUDDY_HOME);
  if (configured) return configured;
  const configDir = stringValue(env.CODEBUDDY_CONFIG_DIR);
  const workBuddyConfigDir = stringValue(env.WORKBUDDY_CONFIG_DIR);
  const normalizeHome = platform === "win32"
    ? (home) => win32.resolve(home).toLowerCase()
    : resolve;
  // WorkBuddy also exports its native home as CODEBUDDY_CONFIG_DIR for compatibility.
  // That alias must not redirect the standalone CLI into WorkBuddy's installation.
  if (configDir && (!workBuddyConfigDir || normalizeHome(configDir) !== normalizeHome(workBuddyConfigDir))) return configDir;
  return (platform === "win32" ? win32.join : join)(homeDir, ".codebuddy");
}

export function defaultWorkBuddyHome(env = process.env, homeDir = homedir(), platform = process.platform) {
  const configured = stringValue(env.WORKBUDDY_HOME) ?? stringValue(env.WORKBUDDY_CONFIG_DIR);
  if (configured) return configured;
  const pathJoin = platform === "win32" ? win32.join : join;
  const legacyHome = pathJoin(homeDir, ".codebuddy");
  const legacyMetadata = readCodeBuddyPackageMetadata(pathJoin(legacyHome, "plugins", "marketplaces", "memorax-code-local", "plugins", "memorax-code-codebuddy-adapter"));
  // Only owned installation metadata can identify the historical Windows home.
  if (platform === "win32" && codeBuddyMetadataClient(legacyMetadata, { env, platform }) === "workbuddy"
    && (!legacyMetadata.codeBuddyHome || legacyMetadata.codeBuddyHome.replaceAll("\\", "/").toLowerCase() === legacyHome.replaceAll("\\", "/").toLowerCase())) return legacyHome;
  return pathJoin(homeDir, ".workbuddy");
}

export function codeBuddyMetadataClient(metadata, { workBuddyHome, env = process.env, platform = process.platform } = {}) {
  if (metadata?.version !== 1) return undefined;
  if (metadata?.client === "codebuddy" || metadata?.client === "workbuddy") return metadata.client;
  if (metadata?.client !== undefined) return undefined;
  if (!stringValue(metadata.codeBuddyCommand)) return undefined;
  const nativeHome = stringValue(metadata.codeBuddyHome);
  const configuredHome = stringValue(workBuddyHome) ?? stringValue(env.WORKBUDDY_HOME) ?? stringValue(env.WORKBUDDY_CONFIG_DIR);
  const normalizeHome = platform === "win32"
    ? (home) => win32.resolve(home).toLowerCase()
    : resolve;
  // Old WorkBuddy installs could use a PATH or configured CLI. The owned home
  // disambiguates those records; an unqualified .codebuddy home alone cannot.
  const workBuddyRoot = nativeHome && (win32.basename(nativeHome).toLowerCase() === ".workbuddy"
    || (configuredHome && normalizeHome(nativeHome) === normalizeHome(configuredHome)));
  return isWorkBuddyBundledCommand(metadata.codeBuddyCommand) || workBuddyRoot ? "workbuddy" : "codebuddy";
}

export function isWorkBuddyBundledCommand(command) {
  return typeof command === "string"
    && /(?:\/(?:WorkBuddy|CodeBuddy)\.app\/Contents\/Resources\/|\/(?:WorkBuddy|CodeBuddy)\/resources\/)app\.asar\.unpacked\/cli\/bin\/codebuddy(?:\.exe)?$/i.test(command.replaceAll("\\", "/"));
}

export function readCodeBuddyPackageMetadata(pluginRoot) {
  if (!pluginRoot) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(join(pluginRoot, ".memorax-code-package.json"), "utf8"));
    return metadata?.version === 1 ? metadata : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve only the selected client's executable; GUI workers cannot assume a shell PATH. */
export function resolveHookCodeBuddyCommand({
  client,
  env = process.env,
  pluginRoot,
  homeDir = homedir(),
  platform = process.platform,
  pathExists = commandPathExists,
} = {}) {
  const metadata = readCodeBuddyPackageMetadata(stringValue(pluginRoot) ?? stringValue(env.CODEBUDDY_PLUGIN_ROOT));
  const metadataClient = codeBuddyMetadataClient(metadata, { env, platform });
  const selectedClient = client ?? metadataClient ?? "codebuddy";
  if (selectedClient !== "codebuddy" && selectedClient !== "workbuddy") throw new Error("invalid CodeBuddy adapter client");
  // Installed workers retain their selected command even when the ambient
  // shell or application exports another client's command overrides.
  const metadataCommand = metadataClient === selectedClient ? stringValue(metadata?.codeBuddyCommand) : undefined;
  if (metadataCommand) return metadataCommand;
  const configured = selectedClient === "workbuddy"
    ? stringValue(env.MEMORAX_CODE_WORKBUDDY_COMMAND) ?? stringValue(env.WORKBUDDY_CODEBUDDY_PATH)
    : stringValue(env.MEMORAX_CODE_CODEBUDDY_COMMAND) ?? stringValue(env.CODEBUDDY_CLI_PATH);
  if (configured) return configured;
  if (selectedClient === "codebuddy") return "codebuddy";
  const bundled = bundledCodeBuddyCommand({ env, homeDir, platform, pathExists });
  if (bundled) return bundled;
  throw new Error("WorkBuddy runtime is unavailable; set MEMORAX_CODE_WORKBUDDY_COMMAND or WORKBUDDY_CODEBUDDY_PATH");
}

function bundledCodeBuddyCommand({ env, homeDir, platform, pathExists }) {
  if (platform === "darwin") {
    for (const root of [join(homeDir, "Applications"), "/Applications"]) {
      for (const appName of APP_NAMES) {
        const command = join(root, appName, ...BUNDLED_SEGMENTS);
        if (pathExists(command, platform)) return command;
      }
    }
  }
  if (platform === "win32") {
    const localAppData = stringValue(env.LOCALAPPDATA) ?? win32.join(homeDir, "AppData", "Local");
    const programFiles = stringValue(env.ProgramFiles) ?? "C:\\Program Files";
    const programFilesX86 = stringValue(env["ProgramFiles(x86)"]) ?? "C:\\Program Files (x86)";
    for (const root of [
      win32.join(localAppData, "Programs", "WorkBuddy"),
      win32.join(localAppData, "Programs", "CodeBuddy"),
      win32.join(localAppData, "WorkBuddy"),
      win32.join(localAppData, "CodeBuddy"),
      win32.join(programFiles, "WorkBuddy"),
      win32.join(programFiles, "CodeBuddy"),
      win32.join(programFilesX86, "WorkBuddy"),
      win32.join(programFilesX86, "CodeBuddy"),
    ]) {
      for (const segments of WINDOWS_SEGMENTS) {
        const command = win32.join(root, ...segments);
        if (pathExists(command, platform)) return command;
      }
    }
  }
  return undefined;
}

function commandPathExists(command, platform) {
  if (!command.includes("/") && !command.includes("\\")) return true;
  if (!existsSync(command)) return false;
  try {
    accessSync(command, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

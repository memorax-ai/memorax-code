import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_NAMES = ["WorkBuddy.app", "CodeBuddy.app"];
const BUNDLED_SEGMENTS = ["Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy"];
const WINDOWS_SEGMENTS = ["resources", "app.asar.unpacked", "cli", "bin", "codebuddy.exe"];

/**
 * Resolve the CodeBuddy executable from the environment, installed adapter
 * metadata, or the WorkBuddy/CodeBuddy application bundle.  Hooks are often
 * launched by a GUI process and therefore cannot rely on the user's shell
 * PATH or on npm's environment setup.
 */
export function resolveHookCodeBuddyCommand({ env = process.env, pluginRoot, homeDir = homedir(), platform = process.platform } = {}) {
  const configured = stringValue(env.MEMORAX_CODE_CODEBUDDY_COMMAND)
    ?? stringValue(env.CODEBUDDY_CLI_PATH)
    ?? stringValue(env.WORKBUDDY_CODEBUDDY_PATH);
  if (configured) return configured;

  const metadataCommand = readMetadataCommand(stringValue(pluginRoot) ?? stringValue(env.CODEBUDDY_PLUGIN_ROOT));
  if (metadataCommand && commandPathExists(metadataCommand)) return metadataCommand;

  if (platform === "darwin") {
    for (const root of [join(homeDir, "Applications"), "/Applications"]) {
      for (const appName of APP_NAMES) {
        const command = join(root, appName, ...BUNDLED_SEGMENTS);
        if (commandPathExists(command)) return command;
      }
    }
  }
  if (platform === "win32") {
    for (const root of [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "WorkBuddy"),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "CodeBuddy"),
      env.ProgramFiles && join(env.ProgramFiles, "WorkBuddy"),
      env.ProgramFiles && join(env.ProgramFiles, "CodeBuddy"),
    ].filter(Boolean)) {
      const command = join(root, ...WINDOWS_SEGMENTS);
      if (commandPathExists(command)) return command;
    }
  }
  return platform === "win32" ? "codebuddy.exe" : "codebuddy";
}

function readMetadataCommand(pluginRoot) {
  if (!pluginRoot) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(join(pluginRoot, ".memorax-code-package.json"), "utf8"));
    return stringValue(metadata?.codeBuddyCommand);
  } catch {
    return undefined;
  }
}

function commandPathExists(command) {
  if (!command.includes("/") && !command.includes("\\")) return true;
  if (!existsSync(command)) return false;
  try {
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

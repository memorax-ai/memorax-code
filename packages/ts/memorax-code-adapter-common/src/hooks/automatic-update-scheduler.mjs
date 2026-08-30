import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
import { readSetupCompletionRecord } from "../setup-completion.mjs";

const scheduledHomes = new Set();

export function scheduleAutomaticUpdate(options = {}) {
  const env = options.env ?? process.env;
  if (automaticUpdateDisabled(options.automaticUpdateValue ?? env.MEMORAX_CODE_AUTO_UPDATE)
    || env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS === "1") {
    return false;
  }
  if (!eligibleEvent(options.input)) return false;

  const memoraxCodeHome = nonEmptyString(options.memoraxCodeHome);
  const command = nonEmptyString(options.memoraxCodeCommand);
  const platform = nonEmptyString(options.platform) ?? process.platform;
  if (!memoraxCodeHome
    || !command
    || !commandAvailable(command, env)
    || !commandSupported(command, platform)) return false;

  let completion;
  try {
    completion = readSetupCompletionRecord(memoraxCodeHome);
  } catch {
    return false;
  }
  if (completion.status !== "valid") return false;

  const home = resolve(memoraxCodeHome);
  if (scheduledHomes.has(home)) return false;

  const childArgs = nodeEntrypoint(command)
    ? [command, "update", "--automatic", "--home", home]
    : ["update", "--automatic", "--home", home];
  const childCommand = nodeEntrypoint(command)
    ? nonEmptyString(options.nodePath) ?? process.execPath
    : command;
  try {
    const child = spawn(childCommand, childArgs, {
      detached: true,
      env: {
        ...env,
        MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
        MEMORAX_CODE_HOME: home,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    scheduledHomes.add(home);
    child.once("error", (error) => {
      scheduledHomes.delete(home);
      options.debug?.(`MemoraX Code automatic update could not start: ${error.message}`);
    });
    child.unref();
    return true;
  } catch (error) {
    options.debug?.(`MemoraX Code automatic update could not start: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function eligibleEvent(input) {
  const event = nonEmptyString(input?.hook_event_name) ?? nonEmptyString(input?.hookEventName);
  return !event || event.toLowerCase() === "sessionstart";
}

function commandAvailable(command, env) {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  return String(env.PATH ?? "")
    .split(delimiter)
    .some((directory) => directory && existsSync(join(directory, command)));
}

function commandSupported(command, platform) {
  return platform !== "win32" || nodeEntrypoint(command);
}

function nodeEntrypoint(command) {
  const name = basename(command).toLowerCase();
  return name.endsWith(".mjs") || name.endsWith(".js");
}

function automaticUpdateDisabled(value) {
  return ["0", "false", "no", "off", "disabled"].includes(String(value ?? "").trim().toLowerCase());
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

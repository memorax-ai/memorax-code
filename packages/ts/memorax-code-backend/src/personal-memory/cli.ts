import { executeUserProfile, PREFERENCE_TYPES, StorageError, type UserProfileCommand } from "./user-profile.js";

class UsageError extends Error {}

const COMMON_OPTIONS = ["repo"];
const COMMAND_OPTIONS: Record<string, string[]> = {
  add: ["type", "description", "applies-when", "do-not-apply-when"],
  update: ["id", "description", "applies-when", "do-not-apply-when"],
  delete: ["id"],
  list: [],
};

function usage(command?: string): string {
  const commands: Record<string, string> = {
    add: "add [--repo <repo>] --type <communication|workflow|environment|profile> --description <text> --applies-when <text> [--do-not-apply-when <text>]",
    update: "update [--repo <repo>] --id <id> --description <text> [--applies-when <text>] [--do-not-apply-when <text>]",
    delete: "delete [--repo <repo>] --id <id>",
    list: "list [--repo <repo>]",
  };
  return command && Object.hasOwn(commands, command)
    ? `Usage: memorax-code user-profile ${commands[command]}\n`
    : `Usage: memorax-code user-profile <add|update|delete|list> [options]\n\nManage repo-scoped user profile preferences.\n`;
}

function parseCommand(args: string[]): UserProfileCommand {
  const [command, ...options] = args;
  if (!command || !Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new UsageError(command ? `invalid command: ${command}` : "a command is required");
  }
  const values = new Map<string, string>();
  const names = [...COMMON_OPTIONS, ...COMMAND_OPTIONS[command]];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const equal = option.indexOf("=");
    const rawName = equal < 0 ? option : option.slice(0, equal);
    const matches = rawName.startsWith("--") ? names.filter((name) => name.startsWith(rawName.slice(2))) : [];
    const exact = names.find((name) => rawName === `--${name}`);
    const name = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!name) throw new UsageError(`unrecognized or ambiguous argument: ${rawName}`);
    const value = equal < 0 ? options[++index] : option.slice(equal + 1);
    if (value === undefined || (equal < 0 && value.startsWith("--"))) {
      throw new UsageError(`argument --${name}: expected one argument`);
    }
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new UsageError(`the following argument is required: --${name}`);
    return value;
  };
  const repo = values.get("repo") ?? ".";
  if (command === "list") return { command, repo };
  if (command === "delete") return { command, repo, id: required("id") };
  if (command === "update") return {
    command, repo, id: required("id"), description: required("description"),
    appliesWhen: values.get("applies-when"), doNotApplyWhen: values.get("do-not-apply-when"),
  };
  const type = required("type");
  if (!PREFERENCE_TYPES.includes(type as typeof PREFERENCE_TYPES[number])) {
    throw new UsageError(`argument --type: invalid choice: '${type}'`);
  }
  return {
    command: "add", repo, type: type as typeof PREFERENCE_TYPES[number], description: required("description"),
    appliesWhen: required("applies-when"), doNotApplyWhen: values.get("do-not-apply-when") ?? "",
  };
}

export async function runUserProfileCli(args: string[]): Promise<number> {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(usage(args[0]));
    return 0;
  }
  try {
    const result = executeUserProfile(parseCommand(args));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      process.stderr.write(`${usage(args[0])}memorax-code user-profile: error: ${message}\n`);
      return 2;
    }
    process.stderr.write(error instanceof StorageError
      ? `${JSON.stringify({ ok: false, error: message })}\n`
      : `${message}\n`);
    return 1;
  }
}

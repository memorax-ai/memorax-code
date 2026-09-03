import { execFile, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RepoMemoryContext {
  skillDir: string;
}

export class RepoMemoryError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "RepoMemoryError";
    this.exitCode = exitCode;
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const error = result.error instanceof Error ? result.error : undefined;
  return {
    status: result.status ?? (error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(error ? { error } : {}),
  };
}

export function runCommandAsync(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const commandError = error instanceof Error ? error : undefined;
      const status = commandError && "code" in commandError && typeof commandError.code === "number"
        ? commandError.code
        : commandError
          ? 127
          : 0;
      resolveResult({
        status,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        ...(commandError ? { error: commandError } : {}),
      });
    });
  });
}

export function commandAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    return regularFile(command);
  }
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExtension = Boolean(extname(command));
  return (env.PATH ?? "").split(delimiter).some((directory) => {
    if (!directory) return false;
    if (regularFile(join(directory, command))) return true;
    return !hasExtension && extensions.some((extension) => regularFile(join(directory, `${command}${extension}`)));
  });
}

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function canonicalPath(value: string): string {
  const expanded = expandHome(value);
  const absolute = resolve(expanded);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  return existsSync(parent) ? join(realpathSync.native(parent), basename(absolute)) : absolute;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function jsonText(value: unknown, pretty: boolean): string {
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}

export function commandOutput(value: unknown, pretty: boolean, exitCode = 0): CommandOutput {
  return { exitCode, stdout: jsonText(value, pretty), stderr: "" };
}

export function failedOutput(error: unknown): CommandOutput {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = error instanceof RepoMemoryError ? error.exitCode : 1;
  return { exitCode, stdout: "", stderr: `${message}\n` };
}

export function parseInteger(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new RepoMemoryError(`${name} must be an integer`, 2);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RepoMemoryError(`${name} must be an integer`, 2);
  return parsed;
}

export function requiredValue(values: string[], index: number, option: string): string {
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new RepoMemoryError(`${option} requires a value`, 2);
  }
  return value;
}

export function assertRange(name: string, value: number, minimum: number, maximum: number): void {
  if (value < minimum || value > maximum) {
    throw new RepoMemoryError(`${name} must be from ${minimum} to ${maximum}`, 2);
  }
}

export function unique<T>(values: Iterable<T>, include?: (value: T) => boolean): T[] {
  const seen = new Set<T>();
  const output: T[] = [];
  for (const value of values) {
    if ((include && !include(value)) || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readJsonError(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const positionMatch = /position\s+(\d+)/i.exec(message);
  if (!positionMatch) return message;
  const position = Number(positionMatch[1]);
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = position - lastNewline;
  const concise = message.replace(/\s+in JSON at position \d+.*$/i, "");
  return `line ${line}, column ${column}: ${concise}`;
}

export async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      output[index] = await map(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()));
  return output;
}

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

type WindowsCliResolutionOptions = {
  platform?: NodeJS.Platform;
  resolvedCommand?: string;
  whereOutput?: unknown;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof existsSync;
  spawnSync?: typeof spawnSync;
};

type WindowsNpmResolutionOptions = {
  platform?: NodeJS.Platform;
  nodePath?: string;
  existsSync?: typeof existsSync;
};

export function resolveWindowsCliInvocation(
  command: string,
  args: string[],
  options: WindowsCliResolutionOptions = {},
): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args };
  const pathApi = path.win32;
  const fileExists = options.existsSync ?? existsSync;
  const env = options.env ?? process.env;
  let resolvedCommand = options.resolvedCommand;
  if (!resolvedCommand && !/[\\/]/.test(command)) {
    const located = options.whereOutput === undefined
      ? (options.spawnSync ?? spawnSync)("where.exe", [command], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      : { status: 0, stdout: options.whereOutput };
    if (located.status === 0) {
      resolvedCommand = selectWindowsCommandCandidate(command, located.stdout);
    }
  }
  resolvedCommand ??= command;
  if (/\.(?:exe|com)$/i.test(resolvedCommand)) return { command: resolvedCommand, args };
  if (!/\.(?:cmd|bat)$/i.test(resolvedCommand)) {
    throw new Error(`refusing to execute unsupported Windows command shim: ${resolvedCommand}`);
  }

  const name = pathApi.basename(resolvedCommand).replace(/\.(?:cmd|bat)$/i, "").toLowerCase();
  const nativeCli = nativeCliEntrypointCandidates(name, resolvedCommand, env, pathApi)
    .filter(isNativeEntrypoint)
    .find((candidate) => fileExists(candidate));
  if (nativeCli) return { command: nativeCli, args };
  const cli = cliEntrypointCandidates(name, resolvedCommand, env, pathApi)
    .filter(isNodeEntrypoint)
    .find((candidate) => fileExists(candidate));
  if (!cli) {
    const override = name === "claude" ? "MEMORAX_CODE_CLAUDE_CLI_JS" : "MEMORAX_CODE_CODEX_CLI_JS";
    throw new Error(
      `refusing to execute ${pathApi.basename(resolvedCommand)} through a command shell; `
      + `set ${override} to its Node entrypoint`,
    );
  }
  return { command: options.nodePath ?? process.execPath, args: [cli, ...args] };
}

function nativeCliEntrypointCandidates(
  name: string,
  command: string,
  env: NodeJS.ProcessEnv,
  pathApi: typeof path.win32,
): string[] {
  if (name !== "claude") return [];
  const root = pathApi.dirname(command);
  return [
    env.MEMORAX_CODE_CLAUDE_CLI_EXE,
    env.CLAUDE_CLI_EXE,
    pathApi.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    pathApi.join(root, "..", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
  ].filter((candidate): candidate is string => typeof candidate === "string");
}

function cliEntrypointCandidates(
  name: string,
  command: string,
  env: NodeJS.ProcessEnv,
  pathApi: typeof path.win32,
): string[] {
  const root = pathApi.dirname(command);
  if (name === "codex") {
    return [
      env.MEMORAX_CODE_CODEX_CLI_JS,
      env.CODEX_CLI_JS,
      pathApi.join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
      pathApi.join(root, "..", "@openai", "codex", "bin", "codex.js"),
    ].filter((candidate): candidate is string => typeof candidate === "string");
  }
  if (name === "claude") {
    return [
      env.MEMORAX_CODE_CLAUDE_CLI_JS,
      env.CLAUDE_CLI_JS,
      pathApi.join(root, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
      pathApi.join(root, "..", "@anthropic-ai", "claude-code", "cli.js"),
    ].filter((candidate): candidate is string => typeof candidate === "string");
  }
  return [];
}

function isNativeEntrypoint(value: string): boolean {
  return /\.(?:exe|com)$/i.test(value);
}

function isNodeEntrypoint(value: string): boolean {
  return /\.(?:cjs|js|mjs)$/i.test(value);
}

export function selectWindowsCommandCandidate(command: string, output: unknown): string {
  const candidates = String(output ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = candidates.find((value) => /\.(?:cmd|bat)$/i.test(value))
    ?? candidates.find((value) => /\.(?:exe|com)$/i.test(value));
  if (!selected) {
    throw new Error(`where.exe did not return a safe executable or command shim for ${command}`);
  }
  return selected;
}

export function resolveWindowsNpmInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: WindowsNpmResolutionOptions = {},
): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: "npm", args };
  const nodePath = options.nodePath ?? process.execPath;
  const fileExists = options.existsSync ?? existsSync;
  const candidates = [
    env.MEMORAX_CODE_NPM_EXEC_PATH,
    env.npm_execpath,
    env.NPM_CLI_JS,
    path.win32.join(
      path.win32.dirname(nodePath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    path.win32.join(
      path.win32.dirname(path.win32.dirname(nodePath)),
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter((candidate): candidate is string => (
    typeof candidate === "string" && /\.(?:cjs|js|mjs)$/i.test(candidate)
  ));
  const npmCli = candidates.find((candidate) => fileExists(candidate));
  if (!npmCli) {
    throw new Error(
      "npm CLI JavaScript entrypoint was not found; set MEMORAX_CODE_NPM_EXEC_PATH, "
      + "npm_execpath, or NPM_CLI_JS",
    );
  }
  return { command: nodePath, args: [npmCli, ...args] };
}

export function runProcessWithWindowsNpm(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    let invocation = { command, args };
    try {
      if (command === "npm") {
        invocation = resolveWindowsNpmInvocation(args, options.env);
      }
    } catch (error) {
      resolveResult({
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      resolveResult({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      resolveResult({ ok: code === 0, stdout, stderr });
    });
  });
}

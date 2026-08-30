import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function resolveNpmInvocation(npmArgs, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: "npm", args: npmArgs };
  const nodePath = options.nodePath ?? process.execPath;
  const npmCli = resolveNpmExecPath(options);
  if (npmCli) return { command: nodePath, args: [npmCli, ...npmArgs] };
  throw new Error(
    "npm CLI JavaScript entrypoint was not found; set MEMORAX_CODE_NPM_EXEC_PATH, "
    + "npm_execpath, or NPM_CLI_JS before running memorax-code update",
  );
}

export function resolveNpmExecPath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const nodePath = options.nodePath ?? process.execPath;
  const fileExists = options.existsSync ?? existsSync;
  const pathApi = path.win32;
  const candidates = [
    env.MEMORAX_CODE_NPM_EXEC_PATH,
    env.npm_execpath,
    env.NPM_CLI_JS,
    pathApi.join(pathApi.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
    pathApi.join(
      pathApi.dirname(pathApi.dirname(nodePath)),
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter((candidate) => (
    typeof candidate === "string"
    && pathApi.isAbsolute(candidate)
    && /\.(?:cjs|js|mjs)$/i.test(candidate)
  ));
  return candidates.find((candidate) => fileExists(candidate));
}

export function npmCommandCwd(env = process.env) {
  for (const candidate of [env.HOME, homedir(), "/"]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "/";
}

export async function runNpmCommand(npmArgs, options = {}) {
  const env = options.env ?? process.env;
  const invocation = resolveNpmInvocation(npmArgs, options);
  const cwd = options.cwd ?? npmCommandCwd(env);
  const child = (options.spawnProcess ?? spawn)(invocation.command, invocation.args, {
    cwd,
    env: { ...env, PWD: cwd },
    stdio: options.stdio ?? "inherit",
    windowsHide: options.windowsHide ?? false,
  });
  return await waitForChildProcess(child);
}

export async function waitForChildProcess(child) {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      exitCode: signal ? 1 : (code ?? 1),
      signal,
    }));
  });
}

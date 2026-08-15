import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function resolveWindowsCliInvocation(command, args, options = {}) {
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
    const override = name === "claude"
      ? "MEMORAX_CODE_CLAUDE_CLI_JS"
      : name === "dsh"
        ? "MEMORAX_CODE_DSH_CLI_JS"
        : "MEMORAX_CODE_CODEX_CLI_JS";
    throw new Error(
      `refusing to execute ${pathApi.basename(resolvedCommand)} through a command shell; `
      + `set ${override} to its Node entrypoint`,
    );
  }
  return { command: options.nodePath ?? process.execPath, args: [cli, ...args] };
}

function nativeCliEntrypointCandidates(name, command, env, pathApi) {
  if (name !== "claude") return [];
  const root = pathApi.dirname(command);
  return [
    env.MEMORAX_CODE_CLAUDE_CLI_EXE,
    env.CLAUDE_CLI_EXE,
    pathApi.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    pathApi.join(root, "..", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
  ];
}

function cliEntrypointCandidates(name, command, env, pathApi) {
  const root = pathApi.dirname(command);
  if (name === "codex") {
    return [
      env.MEMORAX_CODE_CODEX_CLI_JS,
      env.CODEX_CLI_JS,
      pathApi.join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
      pathApi.join(root, "..", "@openai", "codex", "bin", "codex.js"),
    ];
  }
  if (name === "claude") {
    return [
      env.MEMORAX_CODE_CLAUDE_CLI_JS,
      env.CLAUDE_CLI_JS,
      pathApi.join(root, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
      pathApi.join(root, "..", "@anthropic-ai", "claude-code", "cli.js"),
    ];
  }
  if (name === "dsh") {
    return [
      env.MEMORAX_CODE_DSH_CLI_JS,
      env.DSH_CLI_JS,
      pathApi.join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      pathApi.join(root, "..", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
  }
  return [];
}

function isNativeEntrypoint(value) {
  return typeof value === "string" && /\.(?:exe|com)$/i.test(value);
}

function isNodeEntrypoint(value) {
  return typeof value === "string" && /\.(?:cjs|js|mjs)$/i.test(value);
}

export function selectWindowsCommandCandidate(command, output) {
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

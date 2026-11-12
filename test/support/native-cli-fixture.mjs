import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function nativeCliCommand(root, client) {
  return join(root, process.platform === "win32" ? client + ".cmd" : "fake-" + client + ".mjs");
}

export async function writeNativeCliFixture(command, client, source) {
  let entrypoint = command;
  if (process.platform === "win32" && command.endsWith(".cmd")) {
    // Use the same npm layout that the production launcher validates, without a shell bypass.
    const packageName = client === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
    const packageRoot = join(dirname(command), "node_modules", ...packageName.split("/"));
    const relativeEntry = client === "codex" ? "bin/codex.js" : "cli.js";
    entrypoint = join(packageRoot, relativeEntry);
    await mkdir(dirname(entrypoint), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: packageName, type: "module" }));
    await writeFile(command, '@echo off\r\n"' + process.execPath + '" "%~dp0node_modules\\'
      + packageName.replaceAll("/", "\\") + "\\" + relativeEntry.replaceAll("/", "\\") + '" %*\r\n');
  } else {
    await mkdir(dirname(entrypoint), { recursive: true });
  }
  await writeFile(entrypoint, source);
  await chmod(entrypoint, 0o755);
}

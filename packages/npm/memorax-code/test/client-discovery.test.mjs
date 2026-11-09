import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsRoot = join(packageRoot, "..", "..", "ts");
const SETUP_CLIENTS = ["codex", "claude", "opencode", "codebuddy", "workbuddy", "trae", "cursor", "qoder"];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-client-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    ...["client-discovery", "resolve-claude-command", "resolve-codebuddy-command", "resolve-codex-command",
      "vscode-extension-command", "windows-cli-invocation"]
      .map((name) => [join(packageRoot, "lib", `${name}.mjs`), join("lib", `${name}.mjs`)]),
    [join(tsRoot, "memorax-code-adapter-common", "src", "clients", "codebuddy-command.mjs"),
      join("lib", "memorax-code-adapter-common", "src", "clients", "codebuddy-command.mjs")],
    ...["trae", "cursor", "qoder"].map((client) => [
      join(tsRoot, `memorax-code-${client}-adapter`, "src", "adapter-paths.mjs"),
      join("lib", `memorax-code-${client}-adapter`, "src", "adapter-paths.mjs"),
    ]),
  ];
  await Promise.all(files.map(async ([source, relativeTarget]) => {
    const target = join(root, relativeTarget);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }));
  await mkdir(join(root, "node_modules"));
  await symlink(join(tsRoot, "memorax-code-backend", "node_modules", "smol-toml"), join(root, "node_modules", "smol-toml"), "dir");
  await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  const memoraxCodeHome = join(root, "home");
  await mkdir(memoraxCodeHome);
  const { discoverNewClients } = await import(pathToFileURL(join(root, "lib", "client-discovery.mjs")).href);
  // Every detector short-circuits on these values, so local installs cannot change the result.
  const env = {
    PATH: join(root, "empty-bin"),
    MEMORAX_CODE_CODEX_COMMAND: process.execPath,
    MEMORAX_CODE_CLAUDE_COMMAND: process.execPath,
    MEMORAX_CODE_CODEBUDDY_COMMAND: process.execPath,
    MEMORAX_CODE_WORKBUDDY_COMMAND: process.execPath,
    OPENCODE_CONFIG_DIR: join(root, "opencode"),
    TRAE_HOME: join(root, "trae"),
    CURSOR_HOME: join(root, "cursor"),
    QODER_CONFIG_DIR: join(root, "qoder"),
  };
  return {
    root,
    env,
    discover: (overrides = {}, deferredClients) => discoverNewClients({
      memoraxCodeHome, deferredClients, env: { ...env, ...overrides },
    }),
    writeConfig: (text) => writeFile(join(memoraxCodeHome, "config.toml"), text),
  };
}

test("discovery returns every installed client missing from a completed selection", async (t) => {
  const { discover, writeConfig } = await fixture(t);
  await writeConfig("[clients]\ndsh = true\n");
  assert.deepEqual(discover(), SETUP_CLIENTS);
});

test("discovery never reports a client with an explicit choice", async (t) => {
  const { discover, writeConfig } = await fixture(t);
  await writeConfig("[clients]\ncodex = true\nclaude = false\nfuture_client = true\n");
  assert.deepEqual(discover(), SETUP_CLIENTS.filter((client) => !["codex", "claude"].includes(client)));
});

test("discovery skips clients waiting for their next attempt", async (t) => {
  const { discover, writeConfig } = await fixture(t);
  await writeConfig("[clients]\ncodex = true\n");
  assert.deepEqual(discover({}, ["claude", "trae"]), SETUP_CLIENTS.filter((client) => !["codex", "claude", "trae"].includes(client)));
});

test("discovery requires a runtime that actually starts", async (t) => {
  const { discover, root, writeConfig } = await fixture(t);
  await writeConfig("[clients]\ncodex = true\nopencode = true\ncodebuddy = true\nworkbuddy = true\ntrae = true\ncursor = true\nqoder = true\n");
  assert.deepEqual(discover({ MEMORAX_CODE_CLAUDE_COMMAND: join(root, "missing-claude") }), []);
  assert.deepEqual(discover(), ["claude"]);
});

test("discovery finds OpenCode from its configuration or PATH", async (t) => {
  const { discover, root, writeConfig } = await fixture(t);
  await writeConfig("[clients]\ncodex = true\nclaude = true\ncodebuddy = true\nworkbuddy = true\ntrae = true\ncursor = true\nqoder = true\n");
  const absent = { OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: join(root, "xdg"), PATHEXT: ".CMD" };
  assert.deepEqual(discover(absent), []);

  assert.deepEqual(discover({ ...absent, OPENCODE_CONFIG_DIR: join(root, "custom-opencode") }), ["opencode"]);

  await mkdir(join(root, "xdg", "opencode"), { recursive: true });
  assert.deepEqual(discover(absent), ["opencode"]);
  await rm(join(root, "xdg", "opencode"), { recursive: true });

  const command = join(root, "bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  await mkdir(dirname(command));
  await writeFile(command, "");
  if (process.platform !== "win32") await chmod(command, 0o755);
  assert.deepEqual(discover({ ...absent, PATH: dirname(command) }), ["opencode"]);
});

test("discovery does nothing without a completed client selection", async (t) => {
  const { discover, writeConfig } = await fixture(t);
  assert.deepEqual(discover(), [], "missing config");
  for (const text of ["not = [valid", "[memorax]\nendpoint = \"x\"\n", "[clients]\n", "[clients]\nfuture_client = false\n", "clients = 1\n"]) {
    await writeConfig(text);
    assert.deepEqual(discover(), [], text);
  }
});

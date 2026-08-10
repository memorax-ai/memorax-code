import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveWindowsCliInvocation } from "../../shared/windows-cli-invocation.js";

const PLUGIN_NAME = "memorax-code-codex-adapter";
const CLI_MARKETPLACE_NAME = "memorax-code";
const APP_SERVER_OPERATION_TIMEOUT_MS = 10_000;
const APP_SERVER_SHUTDOWN_GRACE_MS = 500;
const APP_SERVER_FORCE_SHUTDOWN_GRACE_MS = 250;

export type CodexHook = {
  key: string;
  currentHash: string;
  pluginId?: string;
  handlerType?: string;
  eventName?: string;
  command?: string;
  statusMessage?: string;
  trustStatus?: string;
};

export type CodexPluginHooksOptions = {
  codexHome?: string;
  homeDir?: string;
  codexCommand?: string;
  workspace?: string;
};

export type CodexPluginHookTrustOptions = CodexPluginHooksOptions & {
  yes?: boolean;
  check?: boolean;
  previousHooks?: CodexHook[];
  selectedHooks?: CodexHook[];
};

export type CodexPluginHookSelectionTrustOptions = CodexPluginHooksOptions & {
  hooks: CodexHook[];
};

export type CodexPluginHooksReport = {
  ok: boolean;
  action: "codex-plugin-hooks";
  codexHome: string;
  codexCommand: string;
  workspace: string;
  hooks: CodexHook[];
  startsBackend: false;
};

export type CodexPluginHookTrustReport = {
  ok: boolean;
  action: "codex-plugin-trust-hooks";
  codexHome: string;
  codexCommand: string;
  workspace: string;
  hooks: CodexHook[];
  trustedHooks: number;
  configPath: string;
  checkedOnly: boolean;
  requiresFullReview: boolean;
  startsBackend: false;
};

type CodexPluginContext = {
  codexHome: string;
  codexCommand: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
};

type CodexAppServerClient = {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
};

type CodexUserConfigLayer = {
  filePath: string;
  version: string;
  config: Record<string, unknown>;
};

type ConfigEdit = {
  keyPath: string;
  value: unknown;
  mergeStrategy: "replace" | "upsert";
};

export async function inspectCodexPluginHooks(options: CodexPluginHooksOptions = {}): Promise<CodexPluginHooksReport> {
  const context = resolveCodexPluginContext(options);
  const hooks = await listMemoraxCodeHooks(context.codexCommand, context.workspace, context.env);
  return {
    ok: true,
    action: "codex-plugin-hooks",
    codexHome: context.codexHome,
    codexCommand: context.codexCommand,
    workspace: context.workspace,
    hooks,
    startsBackend: false,
  };
}

export async function trustCodexPluginHooks(options: CodexPluginHookTrustOptions = {}): Promise<CodexPluginHookTrustReport> {
  if (options.previousHooks !== undefined && options.selectedHooks !== undefined) {
    throw new Error("Codex hook trust accepts either a previous hook snapshot or an explicit selection, not both");
  }
  const context = resolveCodexPluginContext(options);
  const currentHooks = await listMemoraxCodeHooks(context.codexCommand, context.workspace, context.env);
  const configPath = join(context.codexHome, "config.toml");
  const requiresFullReview = options.previousHooks !== undefined
    && hookMarketplaceIdentityChanged(options.previousHooks, currentHooks);
  const hooks = requiresFullReview ? [] : hooksRequiringTrust(currentHooks, options);
  if (!options.check && hooks.length > 0) {
    if (!options.yes) await confirmHookTrust(hooks);
    await trustHookSelectionWithContext(context, hooks);
  }
  return {
    ok: true,
    action: "codex-plugin-trust-hooks",
    codexHome: context.codexHome,
    codexCommand: context.codexCommand,
    workspace: context.workspace,
    hooks,
    trustedHooks: options.check ? 0 : hooks.length,
    configPath,
    checkedOnly: options.check === true,
    requiresFullReview,
    startsBackend: false,
  };
}

export async function trustCodexPluginHookSelection(options: CodexPluginHookSelectionTrustOptions): Promise<void> {
  if (options.hooks.length === 0) return;
  const context = resolveCodexPluginContext(options);
  await trustHookSelectionWithContext(context, options.hooks);
}

export async function listMemoraxCodeHooks(command: string, workspace: string, env: NodeJS.ProcessEnv): Promise<CodexHook[]> {
  return await withCodexAppServer(command, workspace, env, async (client) => {
    return await listMemoraxCodeHooksFromClient(client, workspace);
  });
}

export async function confirmHookTrust(hooks: CodexHook[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("refusing to trust Codex plugin hooks without an interactive terminal; rerun with --yes after reviewing the hooks");
  }
  console.log("MemoraX Code will trust the following Codex plugin hooks:");
  for (const hook of hooks) {
    console.log(`  - ${hook.key}${hook.statusMessage ? ` (${hook.statusMessage})` : ""}`);
    if (hook.eventName) console.log(`    event: ${hook.eventName}`);
    if (hook.command) console.log(`    command: ${hook.command}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Trust these hooks? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new Error("hook trust declined");
  } finally {
    rl.close();
  }
}

function resolveCodexPluginContext(options: CodexPluginHooksOptions): CodexPluginContext {
  const home = resolveHome(options.homeDir);
  const codexHome = resolveCodexHome(options.codexHome, home);
  return {
    codexHome,
    codexCommand: options.codexCommand ?? process.env.CODEX_CLI_PATH ?? "codex",
    workspace: resolve(options.workspace ?? process.cwd()),
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
    },
  };
}

async function trustHookSelectionWithContext(
  context: CodexPluginContext,
  selectedHooks: CodexHook[],
): Promise<void> {
  await withCodexAppServer(context.codexCommand, context.workspace, context.env, async (client) => {
    const currentHooks = await listMemoraxCodeHooksFromClient(client, context.workspace);
    const reviewedHooks = exactCurrentHookSelection(currentHooks, selectedHooks);
    const userLayer = await readCodexUserConfigLayer(client, context.workspace);
    const edits = reviewedHooks
      .filter(hookNeedsReview)
      .map((hook): ConfigEdit => ({
        keyPath: `hooks.state.${tomlQuotedKey(hook.key)}.trusted_hash`,
        value: hook.currentHash,
        mergeStrategy: "upsert",
      }));
    if (edits.length > 0) {
      const result = await requestResult(client, "config/batchWrite", {
        edits,
        filePath: userLayer.filePath,
        expectedVersion: userLayer.version,
        reloadUserConfig: true,
      });
      if ((result.status !== "ok" && result.status !== "okOverridden")
        || typeof result.version !== "string"
        || typeof result.filePath !== "string") {
        throw new Error("Codex config/batchWrite returned an invalid response");
      }
    }
    const verifiedHooks = await listMemoraxCodeHooksFromClient(client, context.workspace);
    verifyTrustedHookSelection(verifiedHooks, reviewedHooks);
  });
}

function exactCurrentHookSelection(currentHooks: CodexHook[], selectedHooks: CodexHook[]): CodexHook[] {
  const currentByKey = new Map(currentHooks.map((hook) => [hook.key, hook]));
  const selectedKeys = new Set<string>();
  return selectedHooks.map((expected) => {
    if (selectedKeys.has(expected.key)) throw new Error(`duplicate Codex hook trust selection: ${expected.key}`);
    selectedKeys.add(expected.key);
    const current = currentByKey.get(expected.key);
    if (!current || current.currentHash !== expected.currentHash) {
      throw new Error(`Codex hook changed after review: ${expected.key}`);
    }
    return current;
  });
}

function verifyTrustedHookSelection(currentHooks: CodexHook[], selectedHooks: CodexHook[]): void {
  const currentByKey = new Map(currentHooks.map((hook) => [hook.key, hook]));
  for (const expected of selectedHooks) {
    const current = currentByKey.get(expected.key);
    if (!current || current.currentHash !== expected.currentHash || hookNeedsReview(current)) {
      throw new Error(`Codex hook trust could not be verified: ${expected.key}`);
    }
  }
}

async function readCodexUserConfigLayer(client: CodexAppServerClient, workspace: string): Promise<CodexUserConfigLayer> {
  const result = await requestResult(client, "config/read", { includeLayers: true, cwd: workspace });
  if (!Array.isArray(result.layers)) throw new Error("Codex config/read did not return config layers");
  const userLayers = result.layers.flatMap((layer): CodexUserConfigLayer[] => {
    if (!isRecord(layer) || !isRecord(layer.name) || layer.name.type !== "user") return [];
    if (!("profile" in layer.name)
      || (layer.name.profile !== null && typeof layer.name.profile !== "string")) {
      throw new Error("Codex config/read returned an invalid user config layer");
    }
    if (layer.name.profile !== null) return [];
    if (typeof layer.name.file !== "string"
      || typeof layer.version !== "string"
      || !isRecord(layer.config)) {
      throw new Error("Codex config/read returned an invalid base user config layer");
    }
    return [{ filePath: layer.name.file, version: layer.version, config: layer.config }];
  });
  if (userLayers.length !== 1) {
    throw new Error(`Codex config/read returned ${userLayers.length} base user config layers; expected exactly one`);
  }
  return userLayers[0]!;
}

async function listMemoraxCodeHooksFromClient(client: CodexAppServerClient, workspace: string): Promise<CodexHook[]> {
  const result = await requestResult(client, "hooks/list", { cwds: [workspace] });
  if (!Array.isArray(result.data)) throw new Error("Codex hooks/list returned an invalid result.data payload");
  const hooks: CodexHook[] = [];
  const seenKeys = new Set<string>();
  for (const entry of result.data) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      throw new Error("Codex hooks/list returned an invalid workspace entry");
    }
    if (entry.errors !== undefined && !Array.isArray(entry.errors)) {
      throw new Error("Codex hooks/list returned invalid discovery errors");
    }
    if (Array.isArray(entry.errors) && entry.errors.length > 0) {
      throw new Error("Codex hooks/list reported hook discovery errors");
    }
    for (const value of entry.hooks) {
      if (!isRecord(value) || (typeof value.pluginId !== "string" && value.pluginId !== null)) {
        throw new Error("Codex hooks/list returned invalid hook metadata");
      }
      const memoraxCodePlugin = value.pluginId === `${PLUGIN_NAME}@${CLI_MARKETPLACE_NAME}`;
      const memoraxCodeKey = typeof value.key === "string"
        && value.key.startsWith(`${PLUGIN_NAME}@${CLI_MARKETPLACE_NAME}:`);
      if (!memoraxCodePlugin) {
        if (memoraxCodeKey) throw new Error("Codex hooks/list returned a mismatched MemoraX Code hook identity");
        continue;
      }
      if (typeof value.pluginId !== "string"
        || typeof value.key !== "string"
        || typeof value.currentHash !== "string"
        || value.handlerType !== "command"
        || typeof value.eventName !== "string"
        || value.eventName.length === 0
        || typeof value.command !== "string"
        || value.command.length === 0
        || !isHookTrustStatus(value.trustStatus)) {
        throw new Error("Codex hooks/list returned incomplete MemoraX Code hook metadata");
      }
      if (seenKeys.has(value.key)) throw new Error(`Codex hooks/list returned duplicate Hook key: ${value.key}`);
      seenKeys.add(value.key);
      hooks.push({
        key: value.key,
        currentHash: value.currentHash,
        pluginId: value.pluginId,
        handlerType: value.handlerType,
        eventName: value.eventName,
        command: value.command,
        ...(typeof value.statusMessage === "string" ? { statusMessage: value.statusMessage } : {}),
        trustStatus: value.trustStatus,
      });
    }
  }
  return hooks;
}

async function withCodexAppServer<T>(
  command: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  operation: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const invocation = resolveWindowsCliInvocation(command, ["app-server", "--stdio"], { env });
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let nextRequestId = 0;
  let closing = false;
  let terminalError: Error | undefined;
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<string, {
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  const rejectPending = (error: Error) => {
    terminalError ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stdin.on("error", (error) => {
    if (!closing) rejectPending(error);
  });
  const childExited = new Promise<void>((resolveExited) => {
    child.once("error", (error) => {
      if (!closing) rejectPending(error);
      resolveExited();
    });
    child.once("exit", () => resolveExited());
    child.once("close", () => {
      if (!closing) rejectPending(new Error(stderr || "Codex app-server exited before completing the request"));
    });
  });
  const reader = (async () => {
    for await (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || (typeof parsed.id !== "string" && typeof parsed.id !== "number")) continue;
      const id = String(parsed.id);
      const request = pending.get(id);
      if (!request) continue;
      pending.delete(id);
      request.resolve(parsed);
    }
  })().catch((error: unknown) => {
    if (!closing) rejectPending(error instanceof Error ? error : new Error(String(error)));
  });
  const client: CodexAppServerClient = {
    request(method, params) {
      if (terminalError) return Promise.reject(terminalError);
      return new Promise<Record<string, unknown>>((resolveMessage, reject) => {
        const id = String(++nextRequestId);
        pending.set(id, { resolve: resolveMessage, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      });
    },
  };
  const timeout = setTimeout(() => {
    rejectPending(new Error("timed out while communicating with Codex app-server"));
    child.kill("SIGTERM");
  }, APP_SERVER_OPERATION_TIMEOUT_MS);
  try {
    await requestResult(client, "initialize", {
      clientInfo: { name: "memorax-code-codex-plugin-hooks", version: "0" },
    });
    return await operation(client);
  } finally {
    clearTimeout(timeout);
    closing = true;
    rejectPending(new Error("Codex app-server request was closed"));
    await closeCodexAppServer(child, lines, reader, childExited);
  }
}

async function requestResult(
  client: CodexAppServerClient,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.request(method, params);
  if (isRecord(response.error)) {
    throw new Error(String(response.error.message ?? `${method} failed`));
  }
  if (!isRecord(response.result)) throw new Error(`Codex ${method} returned an invalid response`);
  return response.result;
}

async function closeCodexAppServer(
  child: ChildProcessWithoutNullStreams,
  lines: Interface,
  reader: Promise<void>,
  childExited: Promise<void>,
): Promise<void> {
  lines.close();
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (!await settlesWithin(childExited, APP_SERVER_SHUTDOWN_GRACE_MS)) {
    child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (!await settlesWithin(childExited, APP_SERVER_FORCE_SHUTDOWN_GRACE_MS)) child.unref();
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  await settlesWithin(reader, APP_SERVER_FORCE_SHUTDOWN_GRACE_MS);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hooksRequiringTrust(currentHooks: CodexHook[], options: CodexPluginHookTrustOptions): CodexHook[] {
  if (options.selectedHooks !== undefined) {
    return exactCurrentHookSelection(currentHooks, options.selectedHooks)
      .filter(hookNeedsReview);
  }
  if (options.previousHooks !== undefined) {
    const previousByKey = new Map(options.previousHooks.map((hook) => [hook.key, hook.currentHash]));
    return currentHooks.filter((hook) => hookNeedsReview(hook)
      && previousByKey.get(hook.key) !== hook.currentHash);
  }
  return currentHooks.filter(hookNeedsReview);
}

function hookNeedsReview(hook: CodexHook): boolean {
  return hook.trustStatus === "untrusted" || hook.trustStatus === "modified";
}

function isHookTrustStatus(value: unknown): value is "managed" | "untrusted" | "trusted" | "modified" {
  return value === "managed" || value === "untrusted" || value === "trusted" || value === "modified";
}

function hookMarketplaceIdentityChanged(previousHooks: CodexHook[], currentHooks: CodexHook[]): boolean {
  if (previousHooks.length === 0 || currentHooks.length === 0) return false;
  const previous = new Set(previousHooks.map(hookPluginIdentity));
  const current = new Set(currentHooks.map(hookPluginIdentity));
  return previous.size !== current.size || [...previous].some((identity) => !current.has(identity));
}

function hookPluginIdentity(hook: CodexHook): string {
  return hook.pluginId ?? hook.key.split(":", 1)[0] ?? "";
}

function resolveHome(value: string | undefined): string {
  return resolve(expandHome(nonEmpty(value) ?? process.env.HOME ?? homedir(), homedir()));
}

function resolveCodexHome(value: string | undefined, home: string): string {
  const configured = nonEmpty(value) ?? nonEmpty(process.env.CODEX_HOME);
  return resolve(expandHome(configured ?? join(home, ".codex"), home));
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tomlString(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function tomlQuotedKey(value: string): string {
  return `"${tomlString(value)}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

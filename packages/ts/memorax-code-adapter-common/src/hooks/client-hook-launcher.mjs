import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  injectClientHookInput,
  injectClientHookPluginRoot,
  readStdinJson,
  stringOption,
  withJsonFileLock,
} from "../config-utils.mjs";
import {
  CLIENT_HOOK_RUNTIME_ABI,
  clientHookRuntimePaths,
  readCurrentClientHookRuntime,
  resolveClientHookRuntimeModule,
} from "./hook-runtime-generation.mjs";
import {
  readJsonRuntimeRecord,
  writePrivateJsonRecord,
} from "../runtime-record.mjs";
import { isRepoMemoryJobWorker } from "../repo-memory/repo-memory-job-context.mjs";

const PIN_RECORD_VERSION = 1;
const SHELL_RECORD_VERSION = 1;

export async function runClientHookLauncher({
  client,
  component,
  debugEnv,
  fallbackModuleUrl,
  pluginRoot,
  shellVersion,
} = {}) {
  try {
    if (isRepoMemoryJobWorker()) return;
    const input = await readStdinJson();
    const memoraxCodeHome = resolveMemoraxCodeHome();
    const selection = selectHookRuntime({
      client,
      component,
      fallbackModuleUrl,
      memoraxCodeHome,
      input,
      pluginRoot,
      shellVersion,
    });
    if (!selection) return;
    injectClientHookInput(input);
    const originalPluginRoot = stringOption(pluginRoot);
    if (originalPluginRoot) injectClientHookPluginRoot(originalPluginRoot);
    await import(pathToFileURL(selection.modulePath).href);
  } catch (error) {
    if (process.env[debugEnv] === "1") {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

export function readClientHookShellVersion(pluginRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginRoot, "hooks", "runtime-shell.json"), "utf8"));
    if (parsed?.version !== SHELL_RECORD_VERSION
      || parsed?.runtimeAbi !== CLIENT_HOOK_RUNTIME_ABI
      || !stringOption(parsed?.shellVersion)) {
      return undefined;
    }
    return parsed.shellVersion.trim();
  } catch {
    return undefined;
  }
}

export function selectHookRuntime({
  client,
  component,
  fallbackModuleUrl,
  memoraxCodeHome,
  input,
  pluginRoot,
  shellVersion,
  } = {}) {
  if (client !== "codex" && client !== "claude-code") return undefined;
  const event = hookEvent(input);
  if (!["SessionStart", "UserPromptSubmit", "Stop"].includes(event)) return undefined;
  const sessionId = stringOption(input?.session_id) ?? stringOption(input?.sessionId);
  const turnId = client === "claude-code"
    ? stringOption(input?.prompt_id) ?? stringOption(input?.promptId)
    : stringOption(input?.turn_id) ?? stringOption(input?.turnId);
  const fallback = bundledSelection({
    fallbackModuleUrl,
    pluginRoot,
    shellVersion,
  });

  if (event === "UserPromptSubmit") {
    if (!sessionId || !turnId) return undefined;
    const pin = pinInfo(memoraxCodeHome, client, sessionId);
    return withJsonFileLock(pin.path, () => {
      const turnKey = identityHash(turnId);
      const existing = readPin(pin.path);
      if (existing.status === "invalid") return undefined;
      if (existing.status === "valid") {
        if (existing.record.client !== client
          || existing.record.sessionKey !== pin.sessionKey) return undefined;
        if (existing.record.turnKey === turnKey) {
          return selectionFromPin({
            client,
            component,
            fallback,
            memoraxCodeHome,
            pin: existing.record,
          });
        }
      }
      const selected = currentSelection({
        client,
        component,
        fallback,
        memoraxCodeHome,
      });
      if (!selected) return undefined;
      writePrivateJsonRecord(pin.path, {
        version: PIN_RECORD_VERSION,
        runtimeAbi: CLIENT_HOOK_RUNTIME_ABI,
        client,
        sessionKey: pin.sessionKey,
        turnKey,
        generationSource: selected.generationSource,
        generationId: selected.generationId,
        pinnedAt: new Date().toISOString(),
      }, { durableBoundary: resolve(memoraxCodeHome) });
      return selected;
    });
  }

  if (event === "Stop") {
    if (!sessionId || !turnId) return undefined;
    const pin = pinInfo(memoraxCodeHome, client, sessionId);
    return withJsonFileLock(pin.path, () => {
      const existing = readPin(pin.path);
      if (existing.status !== "valid"
        || existing.record.client !== client
        || existing.record.sessionKey !== pin.sessionKey
        || existing.record.turnKey !== identityHash(turnId)) return undefined;
      return selectionFromPin({
        client,
        component,
        fallback,
        memoraxCodeHome,
        pin: existing.record,
      });
    });
  }

  if (event === "SessionStart" && stringOption(input?.source) === "compact") {
    if (!sessionId) return undefined;
    const pin = pinInfo(memoraxCodeHome, client, sessionId);
    return withJsonFileLock(pin.path, () => {
      const existing = readPin(pin.path);
      if (existing.status !== "valid"
        || existing.record.client !== client
        || existing.record.sessionKey !== pin.sessionKey) return undefined;
      return selectionFromPin({
        client,
        component,
        fallback,
        memoraxCodeHome,
        pin: existing.record,
      });
    });
  }

  return currentSelection({
    client,
    component,
    fallback,
    memoraxCodeHome,
  });
}

function currentSelection({ client, component, fallback, memoraxCodeHome }) {
  const current = readCurrentClientHookRuntime(memoraxCodeHome);
  if (current.status !== "valid") return fallback;
  const resolved = resolveClientHookRuntimeModule({
    memoraxCodeHome,
    client,
    component,
    generationId: current.record.generationId,
  });
  return resolved
    ? {
      generationSource: "durable",
      generationId: current.record.generationId,
      modulePath: resolved.modulePath,
    }
    : fallback;
}

function selectionFromPin({ client, component, fallback, memoraxCodeHome, pin }) {
  if (pin.generationSource === "bundled") {
    return fallback?.generationId === pin.generationId ? fallback : undefined;
  }
  if (pin.generationSource !== "durable") return undefined;
  const resolved = resolveClientHookRuntimeModule({
    memoraxCodeHome,
    client,
    component,
    generationId: pin.generationId,
  });
  return resolved
    ? {
      generationSource: "durable",
      generationId: pin.generationId,
      modulePath: resolved.modulePath,
    }
    : undefined;
}

function bundledSelection({ fallbackModuleUrl, pluginRoot, shellVersion }) {
  const normalizedShellVersion = stringOption(shellVersion);
  if (!normalizedShellVersion || !fallbackModuleUrl || !pluginRoot) return undefined;
  let modulePath;
  try {
    modulePath = resolve(
      fallbackModuleUrl instanceof URL
        ? fileURLToPath(fallbackModuleUrl)
        : String(fallbackModuleUrl),
    );
  } catch {
    return undefined;
  }
  if (!isContainedRegularFile(pluginRoot, modulePath)) return undefined;
  return {
    generationSource: "bundled",
    generationId: `shell-${normalizedShellVersion}`,
    modulePath,
  };
}

function readPin(path) {
  const state = readJsonRuntimeRecord(path);
  if (state.status === "absent") return { status: "absent" };
  if (state.status !== "present" || !isRecord(state.value)) {
    return { status: "invalid" };
  }
  const value = state.value;
  if (value.version !== PIN_RECORD_VERSION
    || value.runtimeAbi !== CLIENT_HOOK_RUNTIME_ABI
    || !["codex", "claude-code"].includes(value.client)
    || !/^[a-f0-9]{64}$/.test(value.sessionKey)
    || !/^[a-f0-9]{64}$/.test(value.turnKey)
    || !["durable", "bundled"].includes(value.generationSource)
    || !stringOption(value.generationId)
    || !validTimestamp(value.pinnedAt)) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    record: {
      version: value.version,
      runtimeAbi: value.runtimeAbi,
      client: value.client,
      sessionKey: value.sessionKey,
      turnKey: value.turnKey,
      generationSource: value.generationSource,
      generationId: value.generationId,
      pinnedAt: value.pinnedAt,
    },
  };
}

function pinInfo(memoraxCodeHome, client, sessionId) {
  const sessionKey = identityHash(sessionId);
  const root = clientHookRuntimePaths(memoraxCodeHome).root;
  return {
    sessionKey,
    path: join(root, "pins", client, `${sessionKey}.json`),
  };
}

function hookEvent(input) {
  return stringOption(input?.hook_event_name)
    ?? stringOption(input?.hookEventName)
    ?? stringOption(input?.event)
    ?? stringOption(input?.type);
}

function resolveMemoraxCodeHome() {
  return resolve(process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code"));
}

function identityHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isContainedRegularFile(boundary, path) {
  const root = resolve(boundary);
  const target = resolve(path);
  const child = relative(root, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return false;
  let current = root;
  try {
    const rootMetadata = lstatSync(current);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return false;
    const parts = child.split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) return false;
      if (index === parts.length - 1) return metadata.isFile();
      if (!metadata.isDirectory()) return false;
    }
  } catch {
    return false;
  }
  return false;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

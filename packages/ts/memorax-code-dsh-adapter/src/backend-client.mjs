import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBackendConnection } from "../memorax-code-adapter-common/src/backend-connection.mjs";
import {
  ensureBackendAvailable,
  stringValue,
} from "../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";
import { createHttpBackendClient } from "./http-client.mjs";
import { requireEnabledDshRuntime } from "./runtime-state.mjs";

// The package assembler materializes adapter-common inside this DSH bundle so
// a profile-local file: install never depends on the parent npm package tree.
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function createDshBackendClient(options = {}) {
  const env = options.env ?? process.env;
  const root = options.pluginRoot ?? pluginRoot;
  const resolveRuntime = options.resolveRuntime
    ?? (() => requireEnabledDshRuntime(root));
  const resolveConnection = options.resolveConnection
    ?? ((runtime) => resolveBackendConnection({ memoraxCodeHome: runtime.memoraxCodeHome, env }));
  const ensureBackend = options.ensureBackend ?? ensureBackendAvailable;
  const httpClient = options.httpClient ?? createHttpBackendClient({
    env,
    resolveConnection: () => resolveConnection(resolveRuntime()),
  });
  let ensureInFlight;
  let ensureRevision;

  async function ensureReady() {
    // This read intentionally precedes the in-flight fast path. A running DSH
    // process must observe stop/uninstall before it can reuse Backend recovery.
    const runtime = resolveRuntime();
    if (ensureInFlight) {
      if (ensureRevision === runtime.revision) return ensureInFlight;
      await ensureInFlight.catch(() => undefined);
      return ensureReady();
    }
    const connection = resolveConnection(runtime);
    ensureRevision = runtime.revision;
    const pending = Promise.resolve(ensureBackend({
      backendConnection: connection,
      ensureBackendValue: env.MEMORAX_CODE_DSH_ENSURE_BACKEND,
      healthTimeoutValue: env.MEMORAX_CODE_DSH_ENSURE_TIMEOUT_MS,
      startTimeoutValue: env.MEMORAX_CODE_DSH_START_TIMEOUT_MS,
      memoraxCodeCommand: stringValue(env.MEMORAX_CODE_DSH_LIFECYCLE_COMMAND)
        ?? stringValue(env.MEMORAX_CODE_COMMAND)
        ?? runtime.memoraxCodeCommand,
      nodePath: process.execPath,
      pluginRoot: root,
      resolveHomes: () => ({ memoraxCodeHome: runtime.memoraxCodeHome }),
      buildStartArgs: (homes, recoveryArguments) => [
        "start",
        "--home",
        homes.memoraxCodeHome,
        ...recoveryArguments,
      ],
      recoveryEnv: {
        MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
        MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: runtime.revision,
      },
      debug: options.debug ?? debugEnsure,
    }));
    const tracked = pending.finally(() => {
      if (ensureInFlight === tracked) {
        ensureInFlight = undefined;
        ensureRevision = undefined;
      }
    });
    ensureInFlight = tracked;
    return ensureInFlight;
  }

  return Object.freeze({
    ensureReady,
    async recordTurnStart(command, request) {
      await waitForEnsure(ensureReady(), request?.signal, 12_000);
      return httpClient.recordTurnStart(command, request);
    },
    async recordSkillReminder(command, request) {
      await waitForEnsure(ensureReady(), request?.signal, 5_000);
      return httpClient.recordSkillReminder(command, request);
    },
    async writebackTurn(command, request) {
      await waitForEnsure(ensureReady(), request?.signal, 5_000);
      return httpClient.writebackTurn(command, request);
    },
  });
}

export const backendClient = createDshBackendClient();

async function waitForEnsure(promise, signal, timeoutMs) {
  signal?.throwIfAborted();
  let timer;
  let abort;
  const boundary = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("MemoraX Code Backend recovery timed out")), timeoutMs);
    if (signal) {
      abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    await Promise.race([promise, boundary]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function debugEnsure(message) {
  if (process.env.MEMORAX_CODE_DSH_DEBUG === "1") {
    console.error(message);
  }
}

export default backendClient;

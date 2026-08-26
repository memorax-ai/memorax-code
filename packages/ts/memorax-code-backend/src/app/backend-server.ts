import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { backendDebug } from "../shared/debug-log.js";
import { createMemoryReminderTraceRecorder } from "../memory/reminder-trace-recorder.js";
import { handleMemoryHookRequest } from "../transport/http/memory-hook.js";
import { createBackendMemoryObservability } from "./memory-observability.js";
import { createMemoryService } from "../memory/service.js";
import type { MemoryObservabilityHook } from "../memory/observability.js";
import { handleHealthRequest } from "../transport/http/health.js";
import { authorized, publicErrorMessage, statusCodeFromError } from "../transport/http/request.js";
import { json } from "../transport/http/json.js";
import { createBackendState, type BackendState } from "./state.js";
import { TRACE_CLIENTS } from "../trace/config.js";
import { pruneExpiredTraceSessionsForClient } from "../trace/store.js";

export type BackendServerOptions = {
  memoryObservability?: MemoryObservabilityHook;
  shutdownTimeoutMs?: number;
};

export type BackendServer = Server & {
  shutdown(): Promise<void>;
};

type BackendShutdownResources = {
  activeRequests: Set<Promise<unknown>>;
  memoryObservability?: MemoryObservabilityHook;
  memoryService: ReturnType<typeof createMemoryService>;
  timeoutMs: number;
};

const DEFAULT_BACKEND_SHUTDOWN_TIMEOUT_MS = 4_000;

export function createBackendServer(
  state = createBackendState(),
  options: BackendServerOptions = {},
): BackendServer {
  const memoryEnv = { ...process.env, MEMORAX_CODE_HOME: state.sessionHome };
  const memoryObservability = createBackendMemoryObservability(
    state.sessionHome,
    options.memoryObservability,
    memoryEnv,
  );
  const memoryService = createMemoryService({
    diagnosticLogger: backendDebug,
    env: memoryEnv,
    memoraxCodeHome: state.sessionHome,
    memoryObservability,
  });
  const memoryHookDependencies = {
    memoryService,
    memoryReminderTraceRecorder: createMemoryReminderTraceRecorder({
      diagnosticLogger: backendDebug,
      env: memoryEnv,
      memoraxCodeHome: state.sessionHome,
    }),
  };
  for (const client of TRACE_CLIENTS) {
    void pruneExpiredTraceSessionsForClient({
      client,
      memoraxCodeHome: state.sessionHome,
    }).catch((error) => {
      backendDebug(`${client}_trace.retention_cleanup_failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    backendDebug("http.request", {
      method: req.method,
      path: url.pathname,
    });
    try {
      if (req.method === "GET" && url.pathname === "/health") return handleHealthRequest(state, res);
      if (!authorized(state, req, url)) return json(res, 401, { ok: false, error: "unauthorized" });
      if (await handleMemoryHookRequest(memoryHookDependencies, url, req, res)) return;
      return json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const status = statusCodeFromError(error);
      const publicMessage = publicErrorMessage(error);
      if (status >= 500) console.error("request failed", error);
      if (res.headersSent) {
        return res.end();
      }
      return json(res, status, { ok: false, error: publicMessage });
    }
  };
  const activeRequests = new Set<Promise<unknown>>();
  const server = createServer((req, res) => {
    const request = handleRequest(req, res);
    activeRequests.add(request);
    void request.then(
      () => activeRequests.delete(request),
      () => activeRequests.delete(request),
    );
  });
  return attachBackendShutdown(server, {
    activeRequests,
    memoryObservability,
    memoryService,
    timeoutMs: positiveShutdownTimeout(options.shutdownTimeoutMs),
  });
}

function attachBackendShutdown(
  server: Server,
  resources: BackendShutdownResources,
): BackendServer {
  const closeHttpServer = server.close.bind(server);
  const backendServer = server as BackendServer;
  let shutdownPromise: Promise<void> | undefined;
  backendServer.shutdown = () => {
    shutdownPromise ??= shutdownBackend(
      backendServer,
      closeHttpServer,
      resources,
    );
    return shutdownPromise;
  };
  backendServer.close = ((callback?: (err?: Error) => void) => {
    void backendServer.shutdown().then(
      () => callback?.(),
      (error) => callback?.(error instanceof Error ? error : new Error(String(error))),
    );
    return backendServer;
  }) as typeof backendServer.close;
  return backendServer;
}

async function shutdownBackend(
  server: BackendServer,
  closeHttpServer: Server["close"],
  resources: BackendShutdownResources,
): Promise<void> {
  const deadline = Date.now() + resources.timeoutMs;
  try {
    await waitForShutdownPhase(
      "http_server",
      closeBackendHttpServer(server, closeHttpServer, resources.timeoutMs),
      deadline,
    );
    await waitForShutdownPhase(
      "http_requests",
      waitForActiveRequests(resources.activeRequests),
      deadline,
    );
    if (Date.now() < deadline) {
      await waitForShutdownPhase(
        "memory_service",
        settleShutdownWork("memory_service", resources.memoryService.drain()),
        deadline,
      );
    }
    if (Date.now() < deadline && resources.memoryObservability?.drain) {
      await waitForShutdownPhase(
        "memory_observability",
        settleShutdownWork(
          "memory_observability",
          resources.memoryObservability.drain(),
        ),
        deadline,
      );
    }
  } finally {
    resources.memoryService.close();
  }
}

function closeBackendHttpServer(
  server: Server,
  closeHttpServer: Server["close"],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => {
      backendDebug("shutdown.http_connections_forced", { timeoutMs });
      try {
        server.closeAllConnections();
      } catch (error) {
        backendDebug("shutdown.http_connections_force_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, timeoutMs);
    const done = (error?: Error) => {
      clearTimeout(forceTimer);
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    };
    try {
      closeHttpServer(done);
      server.closeIdleConnections();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function waitForActiveRequests(activeRequests: Set<Promise<unknown>>): Promise<void> {
  while (activeRequests.size > 0) {
    await Promise.allSettled([...activeRequests]);
  }
}

async function waitForShutdownPhase(
  phase: string,
  work: Promise<void>,
  deadline: number,
): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    backendDebug("shutdown.phase_timed_out", { phase, remainingMs: 0 });
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work.then(
      () => ({ completed: true as const }),
      (error) => ({ completed: true as const, error }),
    ),
    new Promise<{ completed: false }>((resolve) => {
      timer = setTimeout(() => resolve({ completed: false }), remainingMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!result.completed) {
    backendDebug("shutdown.phase_timed_out", { phase, remainingMs });
    return false;
  }
  if ("error" in result) throw result.error;
  return true;
}

async function settleShutdownWork(label: string, work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    backendDebug("shutdown.work_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function positiveShutdownTimeout(value: number | undefined): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return DEFAULT_BACKEND_SHUTDOWN_TIMEOUT_MS;
}

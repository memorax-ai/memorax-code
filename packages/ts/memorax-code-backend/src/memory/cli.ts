import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { backendDebug } from "../shared/debug-log.js";
import { invokeMemoraxMemoryProvider } from "../provider/memorax/adapter.js";
import type { MemoryObservabilityEvent, MemoryObservabilityHook } from "./observability.js";
import {
  defaultMemoraxCodeHome,
  memoryCliAddEnabled,
  memoryCliMaxMemoryChars,
  memoryCliSessionId,
  memoryConfigStatus,
} from "../provider/memorax/config.js";
import {
  resolveConfiguredRepositoryMemory,
  type ConfiguredRepositoryMemory,
  type ConfiguredRepositoryMemoryResult,
} from "./repository-session.js";
import {
  repositoryMemoryScopeContainsWorkspace,
  repositoryMemoryScopeKind,
  repositoryMemoryScopesMatch,
} from "../repository/scope.js";
import { isTraceClient, type TraceClient } from "../trace/context.js";
import { readCurrentTraceTurn, recordTraceEvent } from "../trace/store.js";

type MemoryCliOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

type MemoryCliResult = {
  ok: boolean;
  action: "memory.status" | "memory.search" | "memory.add";
  error?: string;
  provider?: "memory.memorax";
  baseUrl?: string;
  userId?: string;
  baseUserId?: string;
  workspace?: string;
  scopeKind?: "git-repository" | "local-directory" | "codex-projectless";
  effectiveUserId?: string;
  workspaceScope?: "bound" | "unavailable";
  workspaceScopeReason?: string;
  workspaceScopeFallbackReason?: "git_metadata_invalid";
  userAction?: string;
  userNotice?: string;
  searchEnabled?: boolean;
  addEnabled?: boolean;
  config?: unknown;
  query?: string;
  answer?: string;
  items?: unknown[];
  receipt?: unknown;
};

type MemoryCliObservability = {
  hook?: MemoryObservabilityHook;
  flush: () => Promise<void>;
};

type MemoryCliTraceBinding = Readonly<{
  client: TraceClient;
  expectedSessionId?: string;
}>;

export async function runMemoryCli(args: string[], options: MemoryCliOptions = {}): Promise<MemoryCliResult> {
  const command = args[0] || "status";
  const env = options.env ?? process.env;
  const nextOptions = { ...options, env };
  if (command === "status") return await memoryStatus(nextOptions, args.includes("--config-only"));
  if (command === "search") return memorySearch(args.slice(1), nextOptions);
  if (command === "add") return memoryAdd(args.slice(1), nextOptions);
  return { ok: false, action: "memory.status", error: `unknown memory command: ${command}` };
}

async function memoryStatus(options: MemoryCliOptions, configOnly = false): Promise<MemoryCliResult> {
  const env = options.env ?? process.env;
  const status = memoryConfigStatus(env);
  if (configOnly) {
    return {
      ok: status.configured,
      action: "memory.status",
      provider: "memory.memorax",
      searchEnabled: status.search.enabled,
      addEnabled: status.cli.addEnabled,
      config: status,
      ...(status.configured ? {} : { error: status.error }),
    };
  }
  if (!status.configured) {
    return {
      ok: false,
      action: "memory.status",
      provider: "memory.memorax",
      searchEnabled: false,
      addEnabled: status.cli.addEnabled,
      config: status,
      workspaceScope: "unavailable",
      workspaceScopeReason: "config_missing",
      error: status.error,
    };
  }
  const repositoryMemory = await resolveMemoryCliRepositoryMemory(options);
  return {
    ok: true,
    action: "memory.status",
    provider: "memory.memorax",
    baseUrl: status.baseUrl,
    userId: status.userId,
    baseUserId: status.userId,
    ...(repositoryMemory.ok
      ? memoryCliIdentityFields(repositoryMemory.memory)
      : {
        workspaceScope: "unavailable" as const,
        workspaceScopeReason: repositoryMemory.reason,
      }),
    searchEnabled: status.search.enabled,
    addEnabled: status.cli.addEnabled,
    config: status,
  };
}

async function memorySearch(args: string[], options: MemoryCliOptions): Promise<MemoryCliResult> {
  const queryResult = await readTextArg(args, "--query", "--query-file", "query");
  if (!queryResult.ok) return { ok: false, action: "memory.search", error: queryResult.error };
  const query = queryResult.text;
  const repositoryMemory = await resolveMemoryCliRepositoryMemory(options);
  if (!repositoryMemory.ok) {
    return memoryCliRepositoryFailure("memory.search", repositoryMemory, { query });
  }
  const observability = await memoryCliObservability(options.env);
  const response = await invokeMemoraxMemoryProvider(
    { sessionId: memoryCliSessionId(args, options.env), prompt: query },
    {
      provider_family: "memory",
      provider_id: "memory.memorax",
      transport: "external_http",
      slot: "state_context",
      operation: "query",
      query,
      context: {
        ...(limitFromArgs(args) === undefined ? {} : { limit: limitFromArgs(args) }),
      },
    },
    {
      config: repositoryMemory.memory.config,
      diagnosticLogger: backendDebug,
      fetchImpl: options.fetchImpl,
      observability: observability.hook,
      observabilitySource: "memory_cli",
      repositoryScope: repositoryMemory.memory.scope,
    },
  );
  await observability.flush();
  if (!response.ok) return { ok: false, action: "memory.search", query, error: response.error };
  const payload = isRecord(response.result.tool_result_payload) ? response.result.tool_result_payload : {};
  return {
    ok: true,
    action: "memory.search",
    provider: "memory.memorax",
    query,
    ...memoryCliIdentityFields(repositoryMemory.memory),
    answer: typeof payload.answer === "string" ? payload.answer : "",
    items: Array.isArray(payload.items) ? payload.items : [],
    receipt: response.result.dispatch_receipt ?? null,
  };
}

async function memoryAdd(args: string[], options: MemoryCliOptions): Promise<MemoryCliResult> {
  const env = options.env ?? process.env;
  if (env.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED === "false") {
    return { ok: false, action: "memory.add", error: "MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false disables MemoraX add" };
  }
  if (!memoryCliAddEnabled(env)) {
    return { ok: false, action: "memory.add", error: "memory add is disabled by MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED=false or [memory.cli].add_enabled=false" };
  }
  const memoryResult = await readTextArg(args, "--memory", "--memory-file", "memory");
  if (!memoryResult.ok) return { ok: false, action: "memory.add", error: memoryResult.error };
  const memory = memoryResult.text;
  const maxChars = memoryCliMaxMemoryChars(env);
  if (memory.length > maxChars) {
    return { ok: false, action: "memory.add", error: `memory is too long: ${memory.length} chars > ${maxChars}` };
  }
  const memoryType = requiredArg(args, "--type");
  if (!memoryType.ok) return { ok: false, action: "memory.add", error: memoryType.error };
  const reason = requiredArg(args, "--reason");
  if (!reason.ok) return { ok: false, action: "memory.add", error: reason.error };
  const contentOptions = memoryAddContentOptions(args);
  if (!contentOptions.ok) return { ok: false, action: "memory.add", error: contentOptions.error };
  const repositoryMemory = await resolveMemoryCliRepositoryMemory(options);
  if (!repositoryMemory.ok) return memoryCliRepositoryFailure("memory.add", repositoryMemory);

  const sessionId = memoryCliSessionId(args, env);
  const observability = await memoryCliObservability(env);
  const response = await invokeMemoraxMemoryProvider(
    { sessionId, prompt: memory },
    {
      provider_family: "memory",
      provider_id: "memory.memorax",
      transport: "external_http",
      slot: "state_context",
      operation: "writeback",
      dispatch: "async_best_effort",
      context: {
        idempotencyKey: `memory-cli:${sessionId}:${hashText(`${memoryType.value}\n${reason.value}\n${memory}`)}`,
        messages: [{ role: "user", content: memory }],
        ...contentOptions.context,
        metadata: {
          source_detail: "memorax_code_memory_cli",
          memory_type: memoryType.value,
          memorax_code_memory_reason: reason.value,
        },
      },
    },
    {
      config: repositoryMemory.memory.config,
      diagnosticLogger: backendDebug,
      env,
      fetchImpl: options.fetchImpl,
      observability: observability.hook,
      observabilitySource: "memory_cli",
      repositoryScope: repositoryMemory.memory.scope,
    },
  );
  await observability.flush();
  if (!response.ok) return { ok: false, action: "memory.add", error: response.error };
  return {
    ok: true,
    action: "memory.add",
    provider: "memory.memorax",
    ...memoryCliIdentityFields(repositoryMemory.memory),
    receipt: response.result.dispatch_receipt ?? null,
  };
}

async function resolveMemoryCliRepositoryMemory(options: MemoryCliOptions): Promise<ConfiguredRepositoryMemoryResult> {
  const env = options.env ?? process.env;
  const memoraxCodeHome = defaultMemoraxCodeHome(env);
  let turnMemory: ConfiguredRepositoryMemoryResult | undefined;
  const traceBinding = memoryCliTraceBinding(env);
  if (traceBinding?.expectedSessionId) {
    const current = await readCurrentTraceTurn({
      client: traceBinding.client,
      memoraxCodeHome,
      env,
      expectedSessionId: traceBinding.expectedSessionId,
    });
    if (
      current.ok
      && (current.traceContext.cwd?.trim() || current.traceContext.workspaceKind?.trim().toLowerCase() === "projectless")
    ) {
      turnMemory = await resolveConfiguredRepositoryMemory({
        workspaceRoot: current.traceContext.cwd,
        workspaceKind: current.traceContext.workspaceKind,
        memoraxCodeHome,
        env,
      });
      if (!turnMemory.ok) return turnMemory;
    }
  }

  const commandWorkspace = options.cwd ?? process.cwd();
  if (turnMemory?.ok && turnMemory.memory.scope) {
    const turnScope = turnMemory.memory.scope;
    const turnScopeKind = repositoryMemoryScopeKind(turnScope);
    if (
      (turnScopeKind === "codex-projectless" && !turnScope.boundWorkspaceRoot)
      || (
        (turnScopeKind === "codex-projectless" || turnScopeKind === "local-directory")
        && await repositoryMemoryScopeContainsWorkspace(turnScope, commandWorkspace)
      )
    ) {
      return turnMemory;
    }
  }
  const commandMemory = await resolveConfiguredRepositoryMemory({
    workspaceRoot: commandWorkspace,
    memoraxCodeHome,
    env,
  });
  if (!commandMemory.ok || !commandMemory.memory.scope) return commandMemory;
  if (turnMemory?.ok && (!turnMemory.memory.scope || !repositoryMemoryScopesMatch(commandMemory.memory.scope, turnMemory.memory.scope))) {
    const clientLabel = traceBinding?.client === "claude" ? "Claude" : "Codex";
    return {
      ok: false,
      reason: "workspace_scope_mismatch",
      error: `memory CLI cwd does not match the current ${clientLabel} turn repository/workspace scope; start a new session in the target scope`,
    };
  }
  return commandMemory;
}

function memoryCliRepositoryFailure(
  action: "memory.search" | "memory.add",
  failure: Extract<ConfiguredRepositoryMemoryResult, { ok: false }>,
  fields: Pick<MemoryCliResult, "query"> = {},
): MemoryCliResult {
  const userAction = failure.reason === "workspace_scope_mismatch"
    ? "Start a new Codex or Claude Code session from the target repository or local workspace."
    : failure.reason === "workspace_scope_unavailable"
      ? "Start a new Codex or Claude Code session from the target repository or local workspace. If the problem continues, make sure its .git metadata is readable and valid."
      : undefined;
  return {
    ok: false,
    action,
    ...fields,
    ...(userAction ? {
      workspaceScope: "unavailable" as const,
      workspaceScopeReason: failure.reason,
      userAction,
    } : {}),
    error: failure.error,
  };
}

function memoryCliIdentityFields(memory: ConfiguredRepositoryMemory): Pick<
  MemoryCliResult,
  | "baseUserId"
  | "workspace"
  | "scopeKind"
  | "effectiveUserId"
  | "workspaceScope"
  | "workspaceScopeFallbackReason"
  | "userNotice"
> {
  return {
    baseUserId: memory.config.userId,
    ...(memory.scope ? {
      workspace: memory.scope.repositorySlug,
      scopeKind: repositoryMemoryScopeKind(memory.scope),
      effectiveUserId: memory.scope.effectiveUserId,
      workspaceScope: "bound" as const,
      ...(memory.scope.fallbackReason === "git_metadata_invalid" ? {
        workspaceScopeFallbackReason: memory.scope.fallbackReason,
        userNotice: `Git repository metadata is invalid or incomplete. MemoraX Code is using the local folder name "${memory.scope.repositorySlug}" for memory scope, so Search and Add use "${memory.scope.effectiveUserId}". Repair the repository or restore valid .git metadata. Later Search, Add, and automatic writeback in the same client session will automatically use the restored Git repository scope.`,
      } : {}),
    } : {
      workspaceScope: "unavailable" as const,
    }),
  };
}

async function memoryCliObservability(
  env: Record<string, string | undefined> = process.env,
): Promise<MemoryCliObservability> {
  const memoraxCodeHome = defaultMemoraxCodeHome(env);
  const traceBinding = memoryCliTraceBinding(env);
  const current = traceBinding
    ? await readCurrentTraceTurn({
      client: traceBinding.client,
      memoraxCodeHome,
      env,
      expectedSessionId: traceBinding.expectedSessionId,
    })
    : undefined;
  const pending: Promise<unknown>[] = [];
  if (!current?.ok) return { flush: async () => undefined };
  return {
    hook: {
      recordEvent(event: MemoryObservabilityEvent) {
        pending.push(recordTraceEvent({
          memoraxCodeHome,
          env,
          traceContext: current.traceContext,
          type: memoryCliTraceEventType(event),
          source: event.source,
          operation: event.operation,
          ok: event.ok,
          request: event.request,
          response: event.response,
          error: event.error,
        }));
      },
    },
    flush: async () => {
      await Promise.allSettled(pending);
    },
  };
}

function memoryCliTraceBinding(
  env: Record<string, string | undefined>,
): MemoryCliTraceBinding | undefined {
  const explicitClientRaw = env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT;
  const explicitSessionIdRaw = env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID;
  if (explicitClientRaw !== undefined || explicitSessionIdRaw !== undefined) {
    const client = explicitClientRaw?.trim();
    const expectedSessionId = explicitSessionIdRaw?.trim();
    if (!isTraceClient(client) || !expectedSessionId) return undefined;
    return { client, expectedSessionId };
  }

  const expectedSessionId = env.CODEX_THREAD_ID?.trim();
  return expectedSessionId
    ? { client: "codex", expectedSessionId }
    : undefined;
}

function memoryCliTraceEventType(event: MemoryObservabilityEvent): string {
  return event.operation === "writeback" ? "memory_cli_add" : "memory_cli_search";
}

function memoryAddContentOptions(
  args: string[],
):
  | { ok: true; context: Record<string, string> }
  | { ok: false; error: string } {
  const contentType = argValue(args, "--content-type")?.trim();
  const mode = argValue(args, "--mode")?.trim();
  const context: Record<string, string> = {};
  const effectiveContentType = contentType || "code";
  const effectiveMode = mode || (effectiveContentType === "code" ? "pre_summarized" : "default");
  context.contentType = effectiveContentType;
  context.mode = effectiveMode;
  return { ok: true, context };
}

async function readTextArg(
  args: string[],
  inlineFlag: string,
  fileFlag: string,
  label: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const inline = argValue(args, inlineFlag);
  const file = argValue(args, fileFlag);
  if (inline && file) return { ok: false, error: `use either ${inlineFlag} or ${fileFlag}, not both` };
  let text = inline ?? "";
  if (file) {
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      return { ok: false, error: `failed to read ${fileFlag}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  text = text.trim();
  if (!text) return { ok: false, error: `${label} is required` };
  return { ok: true, text };
}

function requiredArg(args: string[], flag: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = argValue(args, flag)?.trim();
  return value ? { ok: true, value } : { ok: false, error: `${flag} is required` };
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function limitFromArgs(args: string[]): number | undefined {
  const value = argValue(args, "--limit");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.trunc(parsed))) : undefined;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

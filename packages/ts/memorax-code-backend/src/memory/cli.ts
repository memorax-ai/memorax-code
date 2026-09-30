import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { backendDebug } from "../shared/debug-log.js";
import { diagnoseMemoryCliFailure, fileErrorFields, memoryCliUnexpectedFailure, type MemoryCliFailureDetails } from "./cli-diagnostics.js";
import { invokeMemoraxMemoryProvider } from "../provider/memorax/adapter.js";
import type { MemoryObservabilityEvent, MemoryObservabilityHook } from "./observability.js";
import {
  defaultMemoraxCodeHome,
  memoryCliAddEnabled,
  memoryCliMaxMemoryChars,
  memoryCliSessionId,
  memoraxAddOptionsFromContext,
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
import { isTraceClient, type TraceClient, type TraceContext } from "../trace/context.js";
import { readCurrentTraceTurn, recordTraceEvent } from "../trace/store.js";
import {
  claimQuotaNotice,
  type QuotaNoticeClaimer,
} from "./quota-notice.js";

type MemoryCliOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  claimQuotaNotice?: QuotaNoticeClaimer;
  diagnosticTrace?: TraceContext;
};

type MemoryCliResult = MemoryCliFailureDetails & {
  ok: boolean;
  action: "memory.status" | "memory.search" | "memory.add";
  error?: string;
  provider?: "memory.memorax";
  baseUrl?: string;
  userId?: string;
  baseUserId?: string;
  workspace?: string;
  scopeKind?: "git-repository" | "local-directory" | "general";
  effectiveUserId?: string;
  workspaceScope?: "bound" | "unavailable";
  workspaceScopeReason?: string;
  workspaceScopeFallbackReason?: "git_metadata_invalid";
  userAction?: string;
  userNotice?: string;
  quotaNotice?: string;
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
  client: TraceClient | "codebuddy-native";
  expectedSessionId?: string;
}>;

export async function runMemoryCli(args: string[], options: MemoryCliOptions = {}): Promise<MemoryCliResult> {
  const command = args[0] || "status";
  const env = options.env ?? process.env;
  const nextOptions: MemoryCliOptions = { ...options, env };
  if (command === "status") return await memoryStatus(nextOptions, args.includes("--config-only"));
  if (command === "search" || command === "add") {
    const action = command === "search" ? "memory.search" : "memory.add";
    let result: MemoryCliResult;
    try {
      result = await (command === "search" ? memorySearch : memoryAdd)(args.slice(1), nextOptions);
    } catch (error) {
      result = { ok: false, action, ...memoryCliUnexpectedFailure(error) };
    }
    if (result.ok) return result;
    const binding = memoryCliTraceBinding(env);
    return diagnoseMemoryCliFailure(
      { ...result, action }, defaultMemoraxCodeHome(env), nextOptions.diagnosticTrace,
      binding?.client === "codebuddy-native" ? undefined : binding?.client,
    );
  }
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
  const scopeOptions = memorySearchScopeOptions(args);
  if (!scopeOptions.ok) return { ...scopeOptions, action: "memory.search", errorCode: "MEMORY_INPUT_INVALID", stage: "input" };
  const queryResult = await readTextArg(args, "--query", "--query-file", "query");
  if (!queryResult.ok) return { ...queryResult, action: "memory.search" };
  const query = queryResult.text;
  const repositoryMemory = await resolveMemoryCliRepositoryMemory(options);
  if (!repositoryMemory.ok) {
    return memoryCliRepositoryFailure("memory.search", repositoryMemory, { query });
  }
  options.diagnosticTrace = repositoryMemory.traceContext;
  const observability = await memoryCliObservability(options.env, repositoryMemory.traceContext);
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
        ...scopeOptions.context,
        ...(limitFromArgs(args) === undefined ? {} : { limit: limitFromArgs(args) }),
      },
    },
    {
      config: repositoryMemory.memory.config,
      diagnosticLogger: backendDebug,
      env: options.env,
      fetchImpl: options.fetchImpl,
      observability: observability.hook,
      observabilitySource: "memory_cli",
      repositoryScope: repositoryMemory.memory.scope,
    },
  );
  await observability.flush();
  if (!response.ok) return { ...response, action: "memory.search" };
  const quotaNotice = response.result.quota
    ? await (options.claimQuotaNotice ?? claimQuotaNotice)(
      repositoryMemory.memory.config,
      response.result.quota,
      { diagnosticLogger: backendDebug, env: options.env },
    )
    : undefined;
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
    ...(quotaNotice ? { quotaNotice } : {}),
  };
}

async function memoryAdd(args: string[], options: MemoryCliOptions): Promise<MemoryCliResult> {
  const env = options.env ?? process.env;
  if (env.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED === "false") {
    return { ok: false, action: "memory.add", errorCode: "MEMORY_ADD_DISABLED", stage: "configuration", error: "MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false disables MemoraX add" };
  }
  if (!memoryCliAddEnabled(env)) {
    return { ok: false, action: "memory.add", errorCode: "MEMORY_ADD_DISABLED", stage: "configuration", error: "memory add is disabled by MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED=false or [memory.cli].add_enabled=false" };
  }
  const memoryResult = await readTextArg(args, "--memory", "--memory-file", "memory");
  if (!memoryResult.ok) return { ...memoryResult, action: "memory.add" };
  const memory = memoryResult.text;
  const maxChars = memoryCliMaxMemoryChars(env);
  if (memory.length > maxChars) {
    return { ok: false, action: "memory.add", error: `memory is too long: ${memory.length} chars > ${maxChars}` };
  }
  const memoryType = requiredArg(args, "--type");
  if (!memoryType.ok) return { ok: false, action: "memory.add", error: memoryType.error };
  const reason = requiredArg(args, "--reason");
  if (!reason.ok) return { ok: false, action: "memory.add", error: reason.error };
  const repositoryMemory = await resolveMemoryCliRepositoryMemory(options);
  if (!repositoryMemory.ok) return memoryCliRepositoryFailure("memory.add", repositoryMemory);
  const contentOptions = memoryAddContentOptions(args, env, repositoryMemory.client);
  if (!contentOptions.ok) return { ok: false, action: "memory.add", error: contentOptions.error };
  options.diagnosticTrace = repositoryMemory.traceContext;

  const sessionId = memoryCliSessionId(args, env);
  const observability = await memoryCliObservability(env, repositoryMemory.traceContext);
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
        idempotencyKey: `memory-cli:${sessionId}:${hashText(`${memoryType.value}\n${reason.value}\n${memory}`)}${contentOptions.context.contentType === "dialogue" ? ":dialogue" : ""}`,
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
  if (!response.ok) return { ...response, action: "memory.add" };
  const quotaNotice = response.result.quota
    ? await (options.claimQuotaNotice ?? claimQuotaNotice)(
      repositoryMemory.memory.config,
      response.result.quota,
      { diagnosticLogger: backendDebug, env },
    )
    : undefined;
  return {
    ok: true,
    action: "memory.add",
    provider: "memory.memorax",
    ...memoryCliIdentityFields(repositoryMemory.memory),
    receipt: response.result.dispatch_receipt ?? null,
    ...(quotaNotice ? { quotaNotice } : {}),
  };
}

async function resolveMemoryCliRepositoryMemory(
  options: MemoryCliOptions,
): Promise<ConfiguredRepositoryMemoryResult & { traceContext?: TraceContext; client?: TraceClient }> {
  const env = options.env ?? process.env;
  const memoraxCodeHome = defaultMemoraxCodeHome(env);
  const binding = memoryCliTraceBinding(env);
  if (binding?.client === "codebuddy-native") {
    // Both products expose the same native session variable. Only a unique,
    // exact current-turn record whose workspace validates can identify one.
    const candidates = await Promise.all((["codebuddy", "workbuddy"] as const).map(async (client) => {
      const current = await readCurrentTraceTurn({ client, memoraxCodeHome, env, expectedSessionId: binding.expectedSessionId });
      if (!current.ok || !current.traceContext.turnId || !current.traceContext.cwd) return undefined;
      const result = await resolveMemoryCliRepositoryMemoryFromTurn(options, current.traceContext);
      return result.ok ? { ...result, traceContext: current.traceContext, client } : result;
    }));
    const matches = candidates.filter((candidate) => candidate?.ok === true);
    if (matches.length === 1) return matches[0]!;
    // Without an operational turn, native shell commands retain ordinary cwd
    // scope. A present turn with conflicting scope must still fail closed.
    if (candidates.every((candidate) => candidate === undefined)) {
      return resolveMemoryCliRepositoryMemoryFromTurn(options);
    }
    return {
      ok: false,
      reason: "workspace_scope_mismatch",
      error: "memory CLI cannot uniquely bind the native CodeBuddy/WorkBuddy session to a current turn in this workspace; start a new session in the target scope",
    };
  }
  const current = binding
    ? await readCurrentTraceTurn({ client: binding.client, memoraxCodeHome, env, expectedSessionId: binding.expectedSessionId })
    : undefined;
  const traceContext = current?.ok ? current.traceContext : undefined;
  const result = await resolveMemoryCliRepositoryMemoryFromTurn(options, traceContext);
  return result.ok ? { ...result, traceContext, client: binding?.client } : result;
}

async function resolveMemoryCliRepositoryMemoryFromTurn(
  options: MemoryCliOptions,
  traceContext?: TraceContext,
): Promise<ConfiguredRepositoryMemoryResult> {
  const env = options.env ?? process.env;
  const memoraxCodeHome = defaultMemoraxCodeHome(env);
  let turnMemory: ConfiguredRepositoryMemoryResult | undefined;
  if (traceContext && (traceContext.cwd?.trim() || traceContext.workspaceKind?.trim().toLowerCase() === "projectless")) {
    // The operational bridge carries exact workspace identity even when tracing is disabled.
    turnMemory = await resolveConfiguredRepositoryMemory({
      workspaceRoot: traceContext.cwd,
      workspaceKind: traceContext.workspaceKind,
      memoraxCodeHome,
      env,
    });
    if (!turnMemory.ok) return turnMemory;
  }

  const commandWorkspace = options.cwd ?? process.cwd();
  const unboundGeneral = turnMemory?.ok
    && turnMemory.memory.scope?.scopeKind === "general"
    && !turnMemory.memory.scope.boundWorkspaceRoot;
  if (turnMemory?.ok && turnMemory.memory.scope) {
    const turnScope = turnMemory.memory.scope;
    const turnScopeKind = repositoryMemoryScopeKind(turnScope);
    if (
      (turnScopeKind === "general" || turnScopeKind === "local-directory")
      && await repositoryMemoryScopeContainsWorkspace(turnScope, commandWorkspace)
    ) {
      return turnMemory;
    }
  }
  const commandMemory = await resolveConfiguredRepositoryMemory({
    workspaceRoot: commandWorkspace,
    // A cwd-less projectless turn still requires a readable, non-Git command
    // directory. Resolve the hint normally so Git authority cannot be bypassed.
    workspaceKind: unboundGeneral ? "projectless" : undefined,
    memoraxCodeHome,
    env,
  });
  if (!commandMemory.ok || !commandMemory.memory.scope) return commandMemory;
  if (unboundGeneral && repositoryMemoryScopeKind(commandMemory.memory.scope) === "general") {
    return commandMemory;
  }
  if (turnMemory?.ok && (!turnMemory.memory.scope || !repositoryMemoryScopesMatch(commandMemory.memory.scope, turnMemory.memory.scope))) {
    const clientLabel = traceClientLabel(traceContext?.client);
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
    ? "Start a new Codex, Claude Code, CodeBuddy CLI, WorkBuddy, DSH, OpenCode, or Cursor session from the target repository or local workspace."
    : failure.reason === "workspace_scope_unavailable"
      ? "Start a new Codex, Claude Code, CodeBuddy CLI, WorkBuddy, DSH, OpenCode, or Cursor session from the target repository or local workspace. If the problem continues, make sure its .git metadata is readable and valid."
      : undefined;
  return {
    ok: false,
    action,
    errorCode: failure.reason === "config_missing" ? "MEMORY_CONFIG_MISSING"
      : failure.reason === "workspace_scope_mismatch" ? "MEMORY_SCOPE_MISMATCH" : "MEMORY_SCOPE_UNAVAILABLE",
    stage: failure.reason === "config_missing" ? "configuration" : "scope",
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
  traceContext?: TraceContext,
): Promise<MemoryCliObservability> {
  const memoraxCodeHome = defaultMemoraxCodeHome(env);
  // Reuse the snapshot whose scope was verified before provider I/O.
  const pending: Promise<unknown>[] = [];
  if (!traceContext) return { flush: async () => undefined };
  return {
    hook: {
      recordEvent(event: MemoryObservabilityEvent) {
        pending.push(recordTraceEvent({
          memoraxCodeHome,
          env,
          traceContext,
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
  if (env.DSH_SHELL === "1") {
    const expectedSessionId = env.DSH_SESSION_ID?.trim();
    return expectedSessionId ? { client: "dsh", expectedSessionId } : undefined;
  }

  const explicitClientRaw = env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT;
  const explicitSessionIdRaw = env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID;
  if (explicitClientRaw !== undefined || explicitSessionIdRaw !== undefined) {
    const client = explicitClientRaw?.trim();
    const expectedSessionId = explicitSessionIdRaw?.trim();
    if (!isTraceClient(client) || !expectedSessionId) return undefined;
    return { client, expectedSessionId };
  }

  // Native WorkBuddy/CodeBuddy tools carry this identity even when the client
  // does not provide CODEBUDDY_ENV_FILE for the SessionStart export bridge.
  const codeBuddySessionId = env.CODEBUDDY_SESSION_ID?.trim();
  if (codeBuddySessionId) return { client: "codebuddy-native", expectedSessionId: codeBuddySessionId };

  const expectedSessionId = env.CODEX_THREAD_ID?.trim();
  return expectedSessionId
    ? { client: "codex", expectedSessionId }
    : undefined;
}

function memoryCliTraceEventType(event: MemoryObservabilityEvent): string {
  return event.operation === "writeback" ? "memory_cli_add" : "memory_cli_search";
}

function traceClientLabel(client: TraceClient | undefined): string {
  if (client === "claude") return "Claude";
  if (client === "dsh") return "DSH";
  if (client === "opencode") return "OpenCode";
  if (client === "codebuddy") return "CodeBuddy CLI";
  if (client === "workbuddy") return "WorkBuddy";
  if (client === "cursor") return "Cursor";
  return client === "codex" ? "Codex" : "coding agent";
}

function memorySearchScopeOptions(args: string[]):
  | { ok: true; context: Record<string, string[]> }
  | { ok: false; error: string } {
  const context: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (["--query", "--query-file", "--limit", "--session-id"].includes(flag ?? "")) {
      index += 1;
      continue;
    }
    if (flag?.startsWith("--sources=") || flag?.startsWith("--document-id=")) {
      return { ok: false, error: "use a space between the search scope flag and its value" };
    }
    if (flag !== "--sources" && flag !== "--document-id") continue;
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` };
    if (flag === "--sources") {
      if (context.sources) return { ok: false, error: "use --sources only once" };
      context.sources = value.split(",").map((source) => source.trim());
    } else {
      (context.document_ids ??= []).push(value);
    }
    index += 1;
  }
  return { ok: true, context };
}

function memoryAddContentOptions(
  args: string[],
  env: Record<string, string | undefined>,
  client?: TraceClient,
):
  | { ok: true; context: Record<string, string> }
  | { ok: false; error: string } {
  const contentType = argValue(args, "--content-type")?.trim();
  const mode = argValue(args, "--mode")?.trim();
  // Resolve only the content route; keep the CLI's existing mode defaults.
  const route = memoraxAddOptionsFromContext({
    ...(contentType ? { contentType } : {}), mode: "default",
  }, env);
  if (!route.ok) return route;
  const effectiveContentType = route.options.contentType
    ?? (client === "workbuddy" ? "dialogue" : "code");
  const effectiveMode = mode || (effectiveContentType === "code" ? "pre_summarized" : "default");
  if (effectiveContentType === "dialogue" && effectiveMode === "pre_summarized") {
    return { ok: false, error: "pre_summarized requires code content" };
  }
  return { ok: true, context: { contentType: effectiveContentType, mode: effectiveMode } };
}

async function readTextArg(
  args: string[],
  inlineFlag: string,
  fileFlag: string,
  label: string,
): Promise<{ ok: true; text: string } | ({ ok: false; error: string } & MemoryCliFailureDetails)> {
  const inline = argValue(args, inlineFlag);
  const file = argValue(args, fileFlag);
  if (inline && file) return { ok: false, error: `use either ${inlineFlag} or ${fileFlag}, not both` };
  let text = inline ?? "";
  if (file) {
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      return { ok: false, error: `failed to read ${fileFlag}`, errorCode: "MEMORY_INPUT_UNREADABLE", stage: "input", ...fileErrorFields(error) };
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

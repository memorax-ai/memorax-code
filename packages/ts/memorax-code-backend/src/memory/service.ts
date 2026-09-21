import { createAutomaticMemoryWritebackRuntime } from "./automatic-writeback.js";
import { readCodingSessionSourceTurn } from "./coding-session-source.js";
import { codingSessionsEnabled, loadMemoraxCodeConfig } from "../config/memorax-code.js";
import { recordWritebackRejection } from "./background-diagnostics.js";
import {
  createCodexMemoryHookRuntime,
  type CodexMemoryHookRuntimeOptions,
  type CodexMemoryHookWritebackResult,
} from "../clients/codex/memory-hook-runtime.js";
import {
  createClaudeMemoryHookRuntime,
  type ClaudeMemoryHookRuntimeOptions,
  type ClaudeMemoryHookWritebackResult,
} from "../clients/claude/memory-hook-runtime.js";
import {
  createDshMemoryHookRuntime,
  type DshMemoryHookWritebackResult,
} from "../clients/dsh/memory-hook-runtime.js";
import {
  createOpenCodeMemoryHookRuntime,
  type OpenCodeMemoryHookWritebackResult,
} from "../clients/opencode/memory-hook-runtime.js";
import { createCodeBuddyMemoryHookRuntime, type CodeBuddyMemoryHookWritebackResult } from "../clients/codebuddy/memory-hook-runtime.js";
import { createTraeMemoryHookRuntime, type TraeMemoryHookWritebackResult } from "../clients/trae/memory-hook-runtime.js";
import { createMemoryTurnCoordinator } from "./turn-coordinator.js";
import {
  createRepositoryMemorySessionRuntime,
} from "./repository-session.js";
import { createPendingQuotaNoticeRuntime } from "./quota-notice.js";
import type {
  MemoryHookTurnStartResult,
  TurnStartCommand,
  WritebackCommand,
} from "./hook-command.js";

export type MemoryServiceOptions = Omit<
  CodexMemoryHookRuntimeOptions,
  "automaticWriteback" | "captureCodingTurns" | "pendingQuotaNotice" | "repositoryMemorySession" | "turnCoordinator"
> & Pick<ClaudeMemoryHookRuntimeOptions, "transcriptReadAttempts" | "transcriptRetryDelayMs">;

type MemoryHookWritebackResult =
  | CodexMemoryHookWritebackResult
  | ClaudeMemoryHookWritebackResult
  | OpenCodeMemoryHookWritebackResult
  | DshMemoryHookWritebackResult
  | CodeBuddyMemoryHookWritebackResult
  | TraeMemoryHookWritebackResult;

export type MemoryService = {
  recordTurnStart(command: TurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writebackTurn(command: WritebackCommand): Promise<MemoryHookWritebackResult>;
  drain(): Promise<void>;
  close(): void;
};

export function createMemoryService(options: MemoryServiceOptions = {}): MemoryService {
  const env = options.env ?? process.env;
  const memoraxCodeHome = options.memoraxCodeHome ?? env.MEMORAX_CODE_HOME?.trim();
  const pendingQuotaNotice = createPendingQuotaNoticeRuntime({
    claimQuotaNotice: options.claimQuotaNotice,
    diagnosticLogger: options.diagnosticLogger,
    env: options.env,
  });
  const automaticWriteback = createAutomaticMemoryWritebackRuntime({
    memoraxCodeHome,
    diagnosticLogger: options.diagnosticLogger,
    queueQuotaNotice: pendingQuotaNotice.queue,
    readCodingSessionTurn: readCodingSessionSourceTurn,
  });
  const fileConfig = loadMemoraxCodeConfig(memoraxCodeHome);
  const captureCodingTurns = codingSessionsEnabled(env, fileConfig);
  const repositoryMemorySession = createRepositoryMemorySessionRuntime({
    onScopeUpgrade(upgrade) {
      automaticWriteback.discardForScopeUpgrade(upgrade);
    },
  });
  const turnCoordinator = createMemoryTurnCoordinator({
    automaticWriteback: automaticWriteback.enqueue,
    now: options.now,
    ttlMs: options.ttlMs,
    maxEntries: options.maxEntries,
    cleanupIntervalMs: options.cleanupIntervalMs,
  });
  const codexHook = createCodexMemoryHookRuntime({
    ...options,
    captureCodingTurns,
    pendingQuotaNotice,
    repositoryMemorySession,
    turnCoordinator,
  });
  const claudeHook = createClaudeMemoryHookRuntime({
    ...options,
    captureCodingTurns,
    pendingQuotaNotice,
    repositoryMemorySession,
    turnCoordinator,
  });
  const openCodeHook = createOpenCodeMemoryHookRuntime({
    ...options,
    captureCodingTurns,
    pendingQuotaNotice,
    repositoryMemorySession,
    turnCoordinator,
  });
  const dshHook = createDshMemoryHookRuntime({
    ...options,
    repositoryMemorySession,
    turnCoordinator,
  });
  const codeBuddyHook = createCodeBuddyMemoryHookRuntime({
    ...options,
    captureCodingTurns,
    pendingQuotaNotice,
    repositoryMemorySession,
    turnCoordinator,
  });
  const workBuddyHook = createCodeBuddyMemoryHookRuntime({
    ...options,
    captureCodingTurns,
    client: "workbuddy",
    pendingQuotaNotice,
    repositoryMemorySession,
    turnCoordinator,
  });
  const traeHook = createTraeMemoryHookRuntime({
    ...options,
    pendingQuotaNotice,
    repositoryMemorySession,
    turnCoordinator,
  });
  async function observeWriteback(command: WritebackCommand, pending: Promise<MemoryHookWritebackResult>): Promise<MemoryHookWritebackResult> {
    const result = await pending;
    if (!result.scheduled) {
      recordWritebackRejection(result.reason, {
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        client: command.client,
        sessionId: command.sessionId,
        turnId: "turnId" in command ? command.turnId
          : "promptId" in command ? command.promptId
          : "userMessageId" in command ? command.userMessageId
          : "turn" in command ? String(command.turn) : undefined,
      });
    }
    return result;
  }
  let closed = false;
  return {
    async recordTurnStart(command) {
      switch (command.client) {
        case "codex":
          return await codexHook.recordTurnStart(command);
        case "claude-code":
          return await claudeHook.recordTurnStart(command);
        case "opencode":
          return await openCodeHook.recordTurnStart(command);
        case "dsh":
          return await dshHook.recordTurnStart(command);
        case "codebuddy":
          return await codeBuddyHook.recordTurnStart(command);
        case "workbuddy":
          return await workBuddyHook.recordTurnStart(command);
        case "trae":
          return await traeHook.recordTurnStart(command);
      }
      return unsupportedMemoryHookCommand(command);
    },
    async writebackTurn(command) {
      switch (command.client) {
        case "codex":
          return await observeWriteback(command, codexHook.writeback(command));
        case "claude-code":
          return await observeWriteback(command, claudeHook.writeback(command));
        case "opencode":
          return await observeWriteback(command, openCodeHook.writeback(command));
        case "dsh":
          return await observeWriteback(command, dshHook.writeback(command));
        case "codebuddy":
          return await observeWriteback(command, codeBuddyHook.writeback(command));
        case "workbuddy":
          return await observeWriteback(command, workBuddyHook.writeback(command));
        case "trae":
          return await observeWriteback(command, traeHook.writeback(command));
      }
      return unsupportedMemoryHookCommand(command);
    },
    async drain() {
      await automaticWriteback.drain();
    },
    close() {
      if (closed) return;
      closed = true;
      codexHook.close();
      claudeHook.close();
      openCodeHook.close();
      dshHook.close();
      codeBuddyHook.close();
      workBuddyHook.close();
      traeHook.close();
      turnCoordinator.close();
      repositoryMemorySession.close();
      automaticWriteback.close();
      pendingQuotaNotice.close();
    },
  };
}

function unsupportedMemoryHookCommand(command: never): never {
  void command;
  throw new Error("unsupported memory Hook command");
}

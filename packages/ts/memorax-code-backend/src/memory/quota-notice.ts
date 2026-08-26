import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  withJsonFileLockAsync,
} from "../../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  loadTrialCredentialRecord,
} from "../../../memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";
import {
  readJsonRuntimeRecord,
  writePrivateJsonRecord,
} from "../../../memorax-code-adapter-common/src/runtime-record.mjs";
import {
  MEMORAX_ACCOUNT_URL,
} from "../../../memorax-code-adapter-common/src/memorax-defaults.mjs";
import { defaultMemoraxCodeHome } from "../config/memorax-code.js";
import type { MemoraxAdapterConfig } from "../provider/memorax/config.js";
import type { MemoraxQuotaSnapshot } from "../provider/memorax/quota.js";
import type { MemoryDiagnosticLogger } from "./observability.js";

const QUOTA_NOTICE_STATE_VERSION = 1;
const DEFAULT_NOTICE_TIMEOUT_MS = 6_000;
const LOCK_TIMEOUT_MS = 500;
const ANONYMOUS_QUOTA_LIMIT = 100;
const NOTICE_LEVELS = [10, 0] as const;
const QUOTA_NOTICE_STATE_KEYS = new Set([
  "version",
  "connection_fingerprint",
  "last_notified_write_level",
  "last_notified_search_level",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type QuotaNoticeLevel = typeof NOTICE_LEVELS[number];

type QuotaNoticeState = Readonly<{
  version: typeof QUOTA_NOTICE_STATE_VERSION;
  connection_fingerprint: string;
  last_notified_write_level: QuotaNoticeLevel | null;
  last_notified_search_level: QuotaNoticeLevel | null;
}>;

type PendingQuotaNotice = Readonly<{
  connectionFingerprint: string;
  quota: MemoraxQuotaSnapshot;
}>;

type TransitionQuotaNoticeState = (
  initial: QuotaNoticeState,
  operation: (current: QuotaNoticeState) => QuotaNoticeState | undefined,
  options: Readonly<{
    memoraxCodeHome: string;
    signal: AbortSignal;
    timeoutMs: number;
  }>,
) => Promise<QuotaNoticeState>;

export type QuotaNoticeOptions = Readonly<{
  diagnosticLogger?: MemoryDiagnosticLogger;
  env?: Record<string, string | undefined>;
  loadTrialCredential?: typeof loadTrialCredentialRecord;
  timeoutMs?: number;
  transitionState?: TransitionQuotaNoticeState;
}>;

export type QuotaNoticeClaimer = (
  config: MemoraxAdapterConfig,
  quota: MemoraxQuotaSnapshot,
  options?: QuotaNoticeOptions,
) => Promise<string | undefined>;

export type PendingQuotaNoticeRuntimeOptions = QuotaNoticeOptions & Readonly<{
  claimQuotaNotice?: QuotaNoticeClaimer;
}>;

export type PendingQuotaNoticeRuntime = Readonly<{
  queue(config: MemoraxAdapterConfig, quota: MemoraxQuotaSnapshot): void;
  claim(config: MemoraxAdapterConfig): Promise<string | undefined>;
  close(): void;
}>;

export const claimQuotaNotice: QuotaNoticeClaimer = async (
  config,
  quota,
  options = {},
) => {
  const env = options.env ?? process.env;
  const memoraxCodeHome = defaultMemoraxCodeHome(env);
  const transitionState = options.transitionState ?? transitionQuotaNoticeState;
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const deadlineAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  const level = quotaNoticeLevel(quota);
  const initial = initialQuotaNoticeState(config);
  const noticeField = quota.featureCode === "memory_write"
    ? "last_notified_write_level"
    : "last_notified_search_level";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let claimed = false;

  try {
    await Promise.race([
      transitionState(initial, (current) => {
        const lastNotifiedLevel = current[noticeField];
        if (level === undefined) {
          return lastNotifiedLevel === null
            ? undefined
            : { ...current, [noticeField]: null };
        }
        if (lastNotifiedLevel !== null && level >= lastNotifiedLevel) {
          return undefined;
        }
        claimed = true;
        return { ...current, [noticeField]: level };
      }, {
        memoraxCodeHome,
        signal: controller.signal,
        timeoutMs: LOCK_TIMEOUT_MS,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Quota notice state update timed out"));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch {
    options.diagnosticLogger?.("memorax_quota_notice.update_failed", {});
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!claimed || level === undefined) return undefined;
  let markId: string | undefined;
  if (quota.limit === ANONYMOUS_QUOTA_LIMIT) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs > 0) {
      let credentialTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const credential = await Promise.race([
          (options.loadTrialCredential ?? loadTrialCredentialRecord)({
            memoraxCodeHome,
            env,
            runtime: { timeoutMs: remainingMs },
          }),
          new Promise<never>((_resolve, reject) => {
            credentialTimeout = setTimeout(
              () => reject(new Error("Quota notice credential lookup timed out")),
              remainingMs,
            );
          }),
        ]);
        if (credential?.state === "ready" && credential.api_key === config.apiKey) {
          markId = credential.mark_id;
        }
      } catch {
        options.diagnosticLogger?.("memorax_quota_notice.mark_id_load_failed", {});
      } finally {
        if (credentialTimeout) clearTimeout(credentialTimeout);
      }
    }
  }
  return quotaNotice(quota, level, config.memoryOutputLanguage, markId);
};

export function createPendingQuotaNoticeRuntime(
  options: PendingQuotaNoticeRuntimeOptions = {},
): PendingQuotaNoticeRuntime {
  const {
    claimQuotaNotice: claim = claimQuotaNotice,
    ...noticeOptions
  } = options;
  let pendingNotice: PendingQuotaNotice | undefined;
  let closed = false;

  return {
    queue(config, quota) {
      if (closed || quota.featureCode !== "memory_write") return;
      if (!pendingNotice || quotaRemainingRatio(quota) < quotaRemainingRatio(pendingNotice.quota)) {
        pendingNotice = {
          connectionFingerprint: quotaNoticeConnectionFingerprint(config),
          quota: { ...quota },
        };
      }
    },
    async claim(config) {
      if (closed || !pendingNotice) return undefined;
      const notice = pendingNotice;
      pendingNotice = undefined;
      if (notice.connectionFingerprint !== quotaNoticeConnectionFingerprint(config)) return undefined;
      try {
        return await claim(config, notice.quota, noticeOptions);
      } catch {
        options.diagnosticLogger?.("memorax_quota_notice.claim_failed", {});
        return undefined;
      }
    },
    close() {
      closed = true;
      pendingNotice = undefined;
    },
  };
}

async function transitionQuotaNoticeState(
  initial: QuotaNoticeState,
  operation: (current: QuotaNoticeState) => QuotaNoticeState | undefined,
  options: Readonly<{
    memoraxCodeHome: string;
    signal: AbortSignal;
    timeoutMs: number;
  }>,
): Promise<QuotaNoticeState> {
  const path = join(options.memoraxCodeHome, "runtime", "memory", "quota-notices.json");
  return await withJsonFileLockAsync(path, async () => {
    const stored = readQuotaNoticeState(path);
    const current = stored?.connection_fingerprint === initial.connection_fingerprint
      ? stored
      : initial;
    const next = operation(current);
    if (!next) return current;
    writePrivateJsonRecord(path, next, { durableBoundary: options.memoraxCodeHome });
    return next;
  }, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

function readQuotaNoticeState(path: string): QuotaNoticeState | undefined {
  const state = readJsonRuntimeRecord(path);
  if (state.status === "absent") return undefined;
  if (state.status !== "present") throw new Error("Quota notice state is unreadable");
  const value = state.value;
  if (value.version !== QUOTA_NOTICE_STATE_VERSION
    || Object.keys(value).some((key) => !QUOTA_NOTICE_STATE_KEYS.has(key))
    || Object.keys(value).length !== QUOTA_NOTICE_STATE_KEYS.size
    || typeof value.connection_fingerprint !== "string"
    || !SHA256_PATTERN.test(value.connection_fingerprint)
    || !validNoticeLevel(value.last_notified_write_level)
    || !validNoticeLevel(value.last_notified_search_level)) {
    throw new Error("Quota notice state is invalid");
  }
  return {
    version: QUOTA_NOTICE_STATE_VERSION,
    connection_fingerprint: value.connection_fingerprint,
    last_notified_write_level: value.last_notified_write_level,
    last_notified_search_level: value.last_notified_search_level,
  };
}

function initialQuotaNoticeState(config: MemoraxAdapterConfig): QuotaNoticeState {
  return {
    version: QUOTA_NOTICE_STATE_VERSION,
    connection_fingerprint: quotaNoticeConnectionFingerprint(config),
    last_notified_write_level: null,
    last_notified_search_level: null,
  };
}

function quotaNoticeConnectionFingerprint(config: MemoraxAdapterConfig): string {
  return createHash("sha256")
    .update(config.baseUrl)
    .update("\0")
    .update(config.apiKey)
    .digest("hex");
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_NOTICE_TIMEOUT_MS;
}

function quotaNoticeLevel(quota: MemoraxQuotaSnapshot): QuotaNoticeLevel | undefined {
  if (quota.remaining === 0) return 0;
  if (quota.limit <= 0) return undefined;
  const percentage = quotaRemainingRatio(quota) * 100;
  if (percentage <= 10) return 10;
  return undefined;
}

function quotaRemainingRatio(quota: MemoraxQuotaSnapshot): number {
  return quota.limit === 0 ? 0 : quota.remaining / quota.limit;
}

function validNoticeLevel(value: unknown): value is QuotaNoticeLevel | null {
  return value === null || NOTICE_LEVELS.some((level) => value === level);
}

function quotaNotice(
  quota: MemoraxQuotaSnapshot,
  level: QuotaNoticeLevel,
  language: MemoraxAdapterConfig["memoryOutputLanguage"],
  markId?: string,
): string {
  if (language === "zh") {
    const quotaName = quota.featureCode === "memory_write" ? "记忆写入" : "记忆搜索";
    const quotaStatus = level === 0 ? "已用完" : `剩余不超过 ${level}%`;
    if (quota.limit !== ANONYMOUS_QUOTA_LIMIT) {
      return [
        `额度提醒：您的 MemoraX Code ${quotaName}额度${quotaStatus}。`,
        `请访问 ${MEMORAX_ACCOUNT_URL} 查看额度或管理账户。`,
      ].join(" ");
    }
    if (markId) {
      return [
        `额度提醒：您的 MemoraX Code ${quotaName}额度${quotaStatus}。`,
        "游客模式有效期为 90 天。",
        `请访问 ${MEMORAX_ACCOUNT_URL} 查看额度、注册或管理账户。`,
        `当前匿名身份的 Mark ID：\`${markId}\`。`,
        "请妥善保管。",
      ].join(" ");
    }
    return [
      `额度提醒：您的 MemoraX Code ${quotaName}额度${quotaStatus}。`,
      "游客模式有效期为 90 天。",
      `请访问 ${MEMORAX_ACCOUNT_URL} 查看额度、注册或管理账户。`,
      "若本机使用的是尚未注册的匿名身份，可以在本机终端运行 `memorax-code account --show-mark-id` 获取用于认领当前身份的 Mark ID。",
      "请妥善保管，不要在聊天中分享。",
    ].join(" ");
  }
  const quotaName = quota.featureCode === "memory_write" ? "memory write" : "memory search";
  const quotaStatus = level === 0
    ? "has been used up"
    : `has ${level}% or less remaining`;
  if (quota.limit !== ANONYMOUS_QUOTA_LIMIT) {
    return [
      `Quota reminder: Your MemoraX Code ${quotaName} quota ${quotaStatus}.`,
      `Visit ${MEMORAX_ACCOUNT_URL} to view your quota or manage your account.`,
    ].join(" ");
  }
  if (markId) {
    return [
      `Quota reminder: Your MemoraX Code ${quotaName} quota ${quotaStatus}.`,
      "Guest mode is available for 90 days.",
      `Visit ${MEMORAX_ACCOUNT_URL} to view your quota, register, or manage your account.`,
      `Mark ID for the current anonymous identity: \`${markId}\`.`,
      "Keep it private.",
    ].join(" ");
  }
  return [
    `Quota reminder: Your MemoraX Code ${quotaName} quota ${quotaStatus}.`,
    "Guest mode is available for 90 days.",
    `Visit ${MEMORAX_ACCOUNT_URL} to view your quota, register, or manage your account.`,
    "If this device uses an unregistered anonymous identity, run `memorax-code account --show-mark-id` in your local terminal to retrieve the Mark ID used to claim it.",
    "Keep it private and do not share it in chat.",
  ].join(" ");
}

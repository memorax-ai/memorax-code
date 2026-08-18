import {
  transitionTrialCredentialRecord,
} from "../../../memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";
import {
  MEMORAX_ACCOUNT_URL,
} from "../../../memorax-code-adapter-common/src/memorax-defaults.mjs";
import { defaultMemoraxCodeHome } from "../config/memorax-code.js";
import type { MemoraxAdapterConfig } from "../provider/memorax/config.js";
import type { MemoraxQuotaSnapshot } from "../provider/memorax/quota.js";
import type { MemoryDiagnosticLogger } from "./observability.js";

type TransitionTrialCredential = typeof transitionTrialCredentialRecord;
const DEFAULT_NOTICE_TIMEOUT_MS = 6_000;
const SECURE_OPERATION_TIMEOUT_MS = 1_500;
const LOCK_TIMEOUT_MS = 500;
const WARNING_THRESHOLD = 9_999;
const WARNING_STEP = 1;

export type TrialQuotaNoticeOptions = Readonly<{
  diagnosticLogger?: MemoryDiagnosticLogger;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  transitionCredential?: TransitionTrialCredential;
}>;

export type TrialQuotaNoticeClaimer = (
  config: MemoraxAdapterConfig,
  quota: MemoraxQuotaSnapshot,
  options?: TrialQuotaNoticeOptions,
) => Promise<string | undefined>;

export type PendingTrialQuotaNoticeRuntimeOptions = TrialQuotaNoticeOptions & Readonly<{
  claimQuotaNotice?: TrialQuotaNoticeClaimer;
}>;

export type PendingTrialQuotaNoticeRuntime = Readonly<{
  queue(quota: MemoraxQuotaSnapshot): void;
  claim(config: MemoraxAdapterConfig): Promise<string | undefined>;
  close(): void;
}>;

export const claimTrialQuotaNotice: TrialQuotaNoticeClaimer = async (
  config,
  quota,
  options = {},
) => {
  if (config.credentialSource !== "trial") return undefined;
  const env = options.env ?? process.env;
  const transitionCredential = options.transitionCredential
    ?? transitionTrialCredentialRecord;
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let claimed = false;
  const warningField = quota.featureCode === "memory_write"
    ? "last_warned_write_level"
    : "last_warned_search_level";

  try {
    await Promise.race([
      transitionCredential((current) => {
        if (current.state !== "ready"
          || current.api_key !== config.apiKey) {
          return undefined;
        }
        const lastWarnedLevel = current[warningField];
        if (quota.remaining > WARNING_THRESHOLD) {
          return lastWarnedLevel === null
            ? undefined
            : { ...current, [warningField]: null };
        }
        const level = quotaWarningLevel(
          quota.remaining,
          WARNING_THRESHOLD,
          WARNING_STEP,
        );
        if (level === undefined
          || (lastWarnedLevel !== null && level >= lastWarnedLevel)) {
          return undefined;
        }
        claimed = true;
        return { ...current, [warningField]: level };
      }, {
        memoraxCodeHome: defaultMemoraxCodeHome(env),
        env,
        runtime: { timeoutMs: SECURE_OPERATION_TIMEOUT_MS },
        lockOptions: {
          signal: controller.signal,
          timeoutMs: LOCK_TIMEOUT_MS,
        },
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Trial quota notice timed out"));
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

  return claimed ? quotaNotice(quota, config.memoryOutputLanguage) : undefined;
};

export function createPendingTrialQuotaNoticeRuntime(
  options: PendingTrialQuotaNoticeRuntimeOptions = {},
): PendingTrialQuotaNoticeRuntime {
  const {
    claimQuotaNotice = claimTrialQuotaNotice,
    ...noticeOptions
  } = options;
  let pendingQuota: MemoraxQuotaSnapshot | undefined;
  let closed = false;

  return {
    queue(quota) {
      if (closed || quota.featureCode !== "memory_write") return;
      if (!pendingQuota || quota.remaining < pendingQuota.remaining) {
        pendingQuota = { ...quota };
      }
    },
    async claim(config) {
      if (closed || !pendingQuota) return undefined;
      const quota = pendingQuota;
      pendingQuota = undefined;
      try {
        return await claimQuotaNotice(config, quota, noticeOptions);
      } catch {
        options.diagnosticLogger?.("memorax_quota_notice.claim_failed", {});
        return undefined;
      }
    },
    close() {
      closed = true;
      pendingQuota = undefined;
    },
  };
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_NOTICE_TIMEOUT_MS;
}

function quotaWarningLevel(
  remaining: number,
  threshold: number,
  step: number,
): number | undefined {
  if (remaining < 0 || threshold === 0 || remaining > threshold) return undefined;
  return Math.min(threshold, Math.ceil(remaining / step) * step);
}

function quotaNotice(
  quota: MemoraxQuotaSnapshot,
  language: MemoraxAdapterConfig["memoryOutputLanguage"],
): string {
  if (language === "zh") {
    const quotaName = quota.featureCode === "memory_write" ? "记忆写入" : "记忆搜索";
    return [
      `警告：MemoraX Code ${quotaName}额度不足：剩余 ${quota.remaining}/${quota.limit} 次。`,
      `请访问 ${MEMORAX_ACCOUNT_URL} 注册或管理账户。`,
      "如需获取 Mark ID，请直接在本机终端运行 `memorax-code account --show-mark-id`。",
      "请妥善保管，不要将其粘贴到聊天中。",
    ].join(" ");
  }
  const quotaName = quota.featureCode === "memory_write" ? "memory write" : "memory search";
  return [
    `Warning: MemoraX Code ${quotaName} quota is running low: ${quota.remaining} of ${quota.limit} remaining.`,
    `Visit ${MEMORAX_ACCOUNT_URL} to register or manage your account.`,
    "To retrieve your Mark ID, run `memorax-code account --show-mark-id` directly in your local terminal.",
    "Keep it private and do not paste it into chat.",
  ].join(" ");
}

import {
  transitionTrialCredentialRecord,
} from "../../../memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";
import { defaultMemoraxCodeHome } from "../config/memorax-code.js";
import type { MemoraxAdapterConfig } from "../provider/memorax/config.js";
import type { MemoraxQuotaSnapshot } from "../provider/memorax/quota.js";
import type { MemoryDiagnosticLogger } from "./observability.js";

type TransitionTrialCredential = typeof transitionTrialCredentialRecord;
const DEFAULT_NOTICE_TIMEOUT_MS = 6_000;
const SECURE_OPERATION_TIMEOUT_MS = 1_500;
const LOCK_TIMEOUT_MS = 500;

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
  let claimed: Readonly<{ pluginMark: string; registerUrl: string }> | undefined;

  try {
    await Promise.race([
      transitionCredential((current) => {
        if (current.state !== "ready"
          || current.api_key !== config.apiKey
          || current.warn_remaining_threshold === null
          || current.warn_remaining_step === null
          || current.register_url === null) {
          return undefined;
        }
        if (quota.remaining > current.warn_remaining_threshold) {
          return current.last_warned_level === null
            ? undefined
            : { ...current, last_warned_level: null };
        }
        const level = quotaWarningLevel(
          quota.remaining,
          current.warn_remaining_threshold,
          current.warn_remaining_step,
        );
        if (level === undefined
          || (current.last_warned_level !== null
            && level >= current.last_warned_level)) {
          return undefined;
        }
        claimed = {
          pluginMark: current.plugin_mark,
          registerUrl: current.register_url,
        };
        return { ...current, last_warned_level: level };
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

  return claimed ? quotaNotice(claimed, quota) : undefined;
};

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
  if (remaining <= 0 || threshold === 0 || remaining > threshold) return undefined;
  return Math.min(threshold, Math.ceil(remaining / step) * step);
}

function quotaNotice(
  credential: Readonly<{ pluginMark: string; registerUrl: string }>,
  quota: MemoraxQuotaSnapshot,
): string {
  return [
    `MemoraX Code quota is running low: ${quota.remaining} of ${quota.limit} remaining.`,
    `Register or manage your account at ${credential.registerUrl}`,
    `(Plugin ID: ${credential.pluginMark}).`,
  ].join(" ");
}

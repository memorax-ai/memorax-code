import {
  defaultMemoraxCodeHome,
  loadMemoraxCodeConfig,
  type MemoraxCodeConfig,
} from "../../config/memorax-code.js";

export type JevConfigFailureReason = "disabled" | "missing_key" | "invalid_config";

export type JevAdapterConfig = Readonly<{
  apiKey: string;
}>;

export type JevConfigStatus = Readonly<{
  enabled: boolean;
  state: JevConfigFailureReason | "configured";
}>;

export function jevConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): { ok: true; config: JevAdapterConfig } | { ok: false; reason: JevConfigFailureReason } {
  const rawEnabled = env.MEMORAX_CODE_JEV_ENABLED;
  const environmentEnabled = rawEnabled === undefined
    ? undefined
    : rawEnabled.trim().toLowerCase();
  if (environmentEnabled !== undefined && environmentEnabled !== "true" && environmentEnabled !== "false") {
    return { ok: false, reason: "invalid_config" };
  }
  if (environmentEnabled === "false") return { ok: false, reason: "disabled" };

  // Read per call so disabling Jev or rotating its key never needs a restart.
  // Parser messages can contain source lines, so expose only a fixed reason.
  let failedToLoad = false;
  const config = fileConfig ?? loadMemoraxCodeConfig(defaultMemoraxCodeHome(env), {
    warn: () => { failedToLoad = true; },
  });
  if (failedToLoad) return { ok: false, reason: "invalid_config" };
  const fileEnabled = config.jev?.enabled;
  if (fileEnabled !== undefined && typeof fileEnabled !== "boolean") {
    return { ok: false, reason: "invalid_config" };
  }
  const enabled = environmentEnabled === "true" || fileEnabled === true;
  if (!enabled) return { ok: false, reason: "disabled" };

  const apiKey = env.MEMORAX_CODE_JEV_API_KEY?.trim() || config.jev?.api_key?.trim();
  if (!apiKey) return { ok: false, reason: "missing_key" };
  return { ok: true, config: { apiKey } };
}

export function jevConfigStatus(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): JevConfigStatus {
  const result = jevConfigFromEnv(env, fileConfig);
  return result.ok
    ? { enabled: true, state: "configured" }
    : { enabled: result.reason === "missing_key", state: result.reason };
}

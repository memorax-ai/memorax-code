import { existsSync } from "node:fs";
import { delimiter } from "node:path";

export type BackendInstallWatchdogConfig = {
  enabled: boolean;
  paths: string[];
  intervalMs: number;
  graceMs: number;
  exitProcess: boolean;
};

export type BackendInstallWatchdogShutdown = {
  reason: "install_missing";
  missingPaths: string[];
};

export type BackendInstallWatchdogHandle = {
  close: () => void;
};

export function resolveBackendInstallWatchdogConfig(
  overrides: Partial<BackendInstallWatchdogConfig> = {},
): BackendInstallWatchdogConfig | undefined {
  const envPaths = nonEmptyString(process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS)
    ?.split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const paths = overrides.paths ?? envPaths;
  if (!paths || paths.length === 0) return undefined;
  return {
    enabled: overrides.enabled ?? parseBooleanEnv(process.env.MEMORAX_CODE_INSTALL_WATCHDOG) ?? true,
    paths,
    intervalMs: clampPositiveInteger(
      overrides.intervalMs ?? Number(process.env.MEMORAX_CODE_INSTALL_WATCH_INTERVAL_MS),
      2000,
    ),
    graceMs: clampPositiveInteger(
      overrides.graceMs ?? Number(process.env.MEMORAX_CODE_INSTALL_WATCH_GRACE_MS),
      10000,
    ),
    exitProcess: overrides.exitProcess ?? parseBooleanEnv(process.env.MEMORAX_CODE_INSTALL_WATCH_EXIT) ?? true,
  };
}

export function startBackendInstallWatchdog(
  config: BackendInstallWatchdogConfig | undefined,
  onShutdown: (event: BackendInstallWatchdogShutdown) => void | Promise<void>,
): BackendInstallWatchdogHandle | undefined {
  if (!config?.enabled || config.paths.length === 0) return undefined;
  let missingSince: number | undefined;
  let triggered = false;
  const check = (): void => {
    if (triggered) return;
    const missingPaths = missingInstallPaths(config);
    if (missingPaths.length === 0) {
      missingSince = undefined;
      return;
    }
    const now = Date.now();
    missingSince ??= now;
    if (now - missingSince < config.graceMs) return;
    triggered = true;
    clearInterval(timer);
    void onShutdown({ reason: "install_missing", missingPaths });
  };
  const timer = setInterval(check, config.intervalMs);
  timer.unref?.();
  check();
  return {
    close() {
      triggered = true;
      clearInterval(timer);
    },
  };
}

function missingInstallPaths(config: BackendInstallWatchdogConfig): string[] {
  return config.paths.filter((path) => !existsSync(path));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clampPositiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.floor(number));
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

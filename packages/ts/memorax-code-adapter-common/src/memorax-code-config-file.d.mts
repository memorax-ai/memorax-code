export const CONFIG_UPDATE_WARNING: string;

export type ConfigFileUpdateResult = "created" | "updated" | "unchanged" | "failed";

export type ConfigFileUpdateFailure = Readonly<{
  stage: "read" | "parse_existing" | "transform" | "parse_candidate" | "prepare_directory" | "check_permissions" | "write_temp" | "backup" | "publish" | "verify" | "cleanup";
  errorCode: string;
  systemCode?: string;
  recordReason?: "not_regular_file" | "invalid_toml" | "content_mismatch" | "type_mismatch" | "mode_mismatch" | "owner_mismatch";
  configState: "preserved" | "restored" | "removed" | "unknown";
  cleanupErrorCode?: "CONFIG_CLEANUP_FAILED" | "CONFIG_ROLLBACK_FAILED";
  cleanupSystemCode?: string;
}>;

export function updateConfigFileAtomically(options: {
  path: string;
  defaultText: string;
  transform: (text: string, parsed: unknown) => string;
  parseToml: (text: string) => unknown;
  warn?: (message: string) => void;
  onFailure?: (failure: ConfigFileUpdateFailure) => void;
  operations?: Record<string, (...args: any[]) => any>;
  platform?: NodeJS.Platform;
}): ConfigFileUpdateResult;

export function ensurePrivateConfigDirectory(
  path: string,
  options?: {
    operations?: Record<string, (...args: any[]) => any>;
    platform?: NodeJS.Platform;
  },
): void;

export function setTomlField(
  text: string,
  section: string,
  key: string,
  renderedValue: string | undefined,
): string;

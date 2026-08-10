export function backendEnv(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[`MEMORAX_CODE_BACKEND_${suffix}`];
}

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

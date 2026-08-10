import { backendEnv } from "../config/backend-env.js";

export function backendDebugEnabled(): boolean {
  const value = backendEnv("DEBUG_REQUESTS");
  return value === "1" || value === "true" || value === "yes";
}

export function backendDebug(message: string, fields: Record<string, unknown> = {}): void {
  if (!backendDebugEnabled()) return;
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  console.error(`[memorax-code-backend:debug] ${message}${suffix ? ` ${suffix}` : ""}`);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

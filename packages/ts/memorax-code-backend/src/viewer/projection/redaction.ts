export function sanitizeMemoryViewerDetails(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return redactViewerPaths(value.slice(0, 12_000));
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMemoryViewerDetails(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/authorization|api[-_]?key|token|secret/i.test(key)) continue;
    if (key.toLowerCase() === "route"
      && typeof item === "string"
      && /^\/api(?:\/[^/\s?#]+)*\/?$/.test(item)) {
      output[key] = item;
      continue;
    }
    if (viewerPathLikeKey(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = sanitizeMemoryViewerDetails(item, depth + 1);
  }
  return output;
}

function viewerPathLikeKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "cwd"
    || normalized === "path"
    || normalized.endsWith("path")
    || normalized === "root"
    || normalized.endsWith("root")
    || normalized === "workspace"
    || normalized === "workingdirectory";
}

export function redactViewerPaths(value: string): string {
  return value
    .split(/(\bhttps?:\/\/[^\s)'"`]+)/gi)
    .map((segment) => {
      if (/^https?:\/\//i.test(segment)) return segment;
      return segment
        .replace(/\bfile:\/\/[^\s)'"`]+/gi, "[REDACTED]")
        .replace(/(^|[\s('"`])\\\\[^\\/\s)'"`]+[\\/][^\s)'"`]+/g, "$1[REDACTED]")
        .replace(/\b[A-Za-z]:[\\/][^\s)'"`]+/g, "[REDACTED]")
        .replace(/(^|[\s('"`])\/(?!\/)[^\s)'"`]+/g, "$1[REDACTED]");
    })
    .join("");
}

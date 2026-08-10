import { redactViewerPaths } from "../projection/redaction.js";
import type {
  MemoryViewerEvent,
  MemoryViewerSessionTitleCandidate,
} from "../model.js";

export type { MemoryViewerSessionTitleCandidate } from "../model.js";

const MAX_SESSION_TITLE_LENGTH = 120;
const COMMON_RELATIVE_PATH_ROOTS = new Set([
  "app",
  "apps",
  "assets",
  "build",
  "config",
  "configs",
  "crates",
  "dist",
  "docs",
  "lib",
  "node_modules",
  "packages",
  "private",
  "public",
  "resources",
  "scripts",
  "src",
  "test",
  "tests",
  "vendor",
]);

export function earliestMemoryViewerSessionTitleCandidates(
  allEvents: readonly MemoryViewerEvent[],
): MemoryViewerSessionTitleCandidate[] {
  const candidates = new Map<string, MemoryViewerSessionTitleCandidate>();
  for (const event of allEvents) {
    if (event.type !== "turn_start" || !event.sessionId) continue;
    const title = normalizedMemoryViewerSessionTitle(event.prompt);
    if (!title) continue;
    const candidate = {
      id: event.id,
      client: event.client,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      title,
    };
    const key = `${event.client}\u0000${event.sessionId}`;
    const current = candidates.get(key);
    if (!current || compareSessionTitleCandidates(candidate, current) < 0) {
      candidates.set(key, candidate);
    }
  }
  return [...candidates.values()];
}

export function normalizedMemoryViewerSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return undefined;
  if (/^(?:[a-z]:[\\/]|[~.]?[\\/]|file:\/\/)/i.test(title)) return undefined;
  const redacted = redactSessionTitlePaths(title).replace(/\s+/g, " ").trim();
  if (!redacted || redacted === "[REDACTED]") return undefined;
  const characters = Array.from(redacted);
  return characters.length <= MAX_SESSION_TITLE_LENGTH
    ? redacted
    : `${characters.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join("")}…`;
}

function compareSessionTitleCandidates(
  left: MemoryViewerSessionTitleCandidate,
  right: MemoryViewerSessionTitleCandidate,
): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  const leftOrder = Number.isFinite(leftTime) ? leftTime : 0;
  const rightOrder = Number.isFinite(rightTime) ? rightTime : 0;
  return leftOrder - rightOrder || left.id.localeCompare(right.id);
}

function redactSessionTitlePaths(value: string): string {
  return redactViewerPaths(value)
    .replace(/(^|[\s('"`])(?:~|\.\.?)?[\\/](?![\\/])[^\s)'"`]+/g, "$1[REDACTED]")
    .replace(/(^|[\s('"`])\\\\[^\\\s]+\\[^\s)'"`]+/g, "$1[REDACTED]")
    .replace(/(^|[\s('"`])([^\s)'"`]*[\\/][^\s)'"`]*)/g, (match, prefix: string, token: string) => (
      likelyPathToken(token) ? `${prefix}[REDACTED]` : match
    ));
}

function likelyPathToken(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (/^[a-z]:[\\/]/i.test(token)) return true;
  const segments = token.split(/[\\/]/).filter(Boolean);
  if (segments.length >= 3) return true;
  if (segments.length < 2) return false;
  if (/\.[a-z0-9]{1,16}(?:[?#].*)?$/i.test(segments.at(-1) ?? "")) return true;
  return COMMON_RELATIVE_PATH_ROOTS.has(segments[0]?.toLowerCase() ?? "");
}

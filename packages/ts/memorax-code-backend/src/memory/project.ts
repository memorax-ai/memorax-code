import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type MemoryProjectIdentity = Readonly<{
  projectId: string;
  projectLabel: string;
}>;

const projectsByCwd = new Map<string, MemoryProjectIdentity>();

export function resolveMemoryProject(cwd: string | undefined): MemoryProjectIdentity | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  const normalizedCwd = normalizePath(cwd);
  const cached = projectsByCwd.get(normalizedCwd);
  if (cached) return cached;

  let current = normalizedCwd;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      const root = normalizePath(current);
      const label = basename(root).trim();
      const identity = {
        projectId: `repo:${createHash("sha256").update(root).digest("hex").slice(0, 32)}`,
        projectLabel: isSafeProjectLabel(label) ? label : "Repository",
      };
      projectsByCwd.set(normalizedCwd, identity);
      return identity;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

export function memoryProjectFromUnknown(value: unknown): MemoryProjectIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawProjectId = rawString(record.projectId) || rawString(record.project_id) || rawString(record.id);
  const rawProjectLabel = rawString(record.projectLabel) || rawString(record.project_label) || rawString(record.label);
  const projectId = rawProjectId.trim();
  const projectLabel = rawProjectLabel.trim();
  if (rawProjectId !== projectId
    || !isMemoryProjectId(projectId)
    || !projectLabel
    || !isSafeProjectLabel(rawProjectLabel)
    || !isSafeProjectLabel(projectLabel)) return undefined;
  return { projectId, projectLabel };
}

function isMemoryProjectId(value: string): boolean {
  return /^repo:[a-f0-9]{32}$/.test(value);
}

function isSafeProjectLabel(value: string): boolean {
  return value.length <= 256
    && value !== "."
    && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function normalizePath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

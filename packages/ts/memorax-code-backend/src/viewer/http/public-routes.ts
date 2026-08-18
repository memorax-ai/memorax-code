import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MEMORAX_ICON_DATA_URL } from "../ui/icon.js";
import { isMemoryProjectId, UNCLASSIFIED_PROJECT_ID } from "../../memory/project.js";
import { MEMORAX_LOGO_DATA_URL } from "../ui/logo.js";
import { memoryViewerUserHtml } from "../ui/user-html.js";
import { projectMemoryViewerUserData } from "../projection/user.js";
import { listMemoryViewerDataWithHistory } from "../store.js";
import {
  repoMemoryReadinessForProject,
  type RepoMemoryReadiness,
} from "../../repository/readiness.js";
import { json } from "../../transport/http/json.js";
import { memoraxCodeHomeForTrace } from "../../trace/config.js";
import type { TraceClient } from "../../trace/context.js";
import type {
  MemoryViewerProjectCatalogEntry,
  MemoryViewerProjectSessionCatalogEntry,
} from "../model.js";

type ViewerResponse = ServerResponse;
type MemoryViewerClient = Extract<TraceClient, "codex" | "claude" | "dsh" | "opencode">;

const MEMORY_VIEWER_SESSION_ACTIVITY_WINDOW_MS = 72 * 60 * 60 * 1_000;
const MEMORY_VIEWER_ACTIVITY_CUTOFF_GRANULARITY_MS = 60_000;
const MEMORY_VIEWER_LOGO = Buffer.from(
  MEMORAX_LOGO_DATA_URL.slice(MEMORAX_LOGO_DATA_URL.indexOf(",") + 1),
  "base64",
);
const MEMORY_VIEWER_ICON = Buffer.from(
  MEMORAX_ICON_DATA_URL.slice(MEMORAX_ICON_DATA_URL.indexOf(",") + 1),
  "base64",
);

export async function handleMemoryViewerRequest(
  url: URL,
  req: IncomingMessage,
  res: ViewerResponse,
  options: {
    env?: Record<string, string | undefined>;
    memoraxCodeHome?: string;
    claudeProjectsRoot?: string | false;
    sessionCookie?: string;
    now?: () => number;
    repoMemoryReadiness?: (projectId: string, memoraxCodeHome: string) => Promise<RepoMemoryReadiness>;
  } = {},
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/memory-viewer") {
    if (!memoryViewerUserClient(url)) {
      json(res, 400, { ok: false, error: "client must be codex, claude-code, dsh, or opencode" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...(options.sessionCookie ? { "set-cookie": options.sessionCookie } : {}),
    });
    res.end(memoryViewerUserHtml());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/memory-viewer/logo") {
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    res.end(MEMORY_VIEWER_LOGO);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/memory-viewer/favicon.png") {
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    res.end(MEMORY_VIEWER_ICON);
    return true;
  }
  if (req.method !== "GET" || url.pathname !== "/memory-viewer/api/summary") {
    return false;
  }

  const memoraxCodeHome = viewerMemoraxCodeHome(options);
  const selectedClient = memoryViewerUserClient(url);
  if (!selectedClient) {
    json(res, 400, { ok: false, error: "client must be codex, claude-code, dsh, or opencode" });
    return true;
  }
  const requestedProject = projectFilter(url);
  const activeSessionSince = memoryViewerActivityCutoff(options.now?.() ?? Date.now());
  const viewerData = await listMemoryViewerDataWithHistory(memoraxCodeHome, {
    client: selectedClient.traceClient,
    includePendingWritebacks: true,
    activeSessionSince,
    includeUserProjection: true,
    ...(requestedProject.projectId ? { projectId: requestedProject.projectId } : {}),
    ...(requestedProject.reject ? { rejectProjectFilter: true } : {}),
  }, { claudeProjectsRoot: options.claudeProjectsRoot });
  const projection = viewerData.userProjection
    ?? projectMemoryViewerUserData(viewerData.events);
  const readiness = options.repoMemoryReadiness ?? repoMemoryReadinessForProject;
  const projects = await Promise.all(
    activeMemoryViewerProjects(
      viewerData.activityProjects,
      viewerData.activityProjectSessions,
      activeSessionSince,
    ).map(async (project) => ({
      projectId: project.projectId,
      projectLabel: project.projectLabel,
      repoMemory: await readiness(project.projectId, memoraxCodeHome),
    })),
  );
  conditionalViewerJson(req, res, {
    ok: true,
    selectedClient: selectedClient.publicClient,
    availableClients: ["codex", "claude-code", "dsh", "opencode"],
    summary: projection.summary,
    activities: projection.activities.slice(0, 100),
    projects,
    ...(viewerData.selectedProjectId ? { selectedProjectId: viewerData.selectedProjectId } : {}),
    ...(viewerData.projectFilterStatus ? { projectFilterStatus: viewerData.projectFilterStatus } : {}),
  });
  return true;
}

function viewerMemoraxCodeHome(
  options: { env?: Record<string, string | undefined>; memoraxCodeHome?: string },
): string {
  return options.memoraxCodeHome
    ?? (options.env?.MEMORAX_CODE_HOME?.trim() || memoraxCodeHomeForTrace(options.env));
}

function memoryViewerUserClient(url: URL): {
  traceClient: MemoryViewerClient;
  publicClient: "codex" | "claude-code" | "dsh" | "opencode";
} | undefined {
  const value = url.searchParams.get("client");
  const traceClient = value === null ? "codex" : traceClientFromPublicValue(value.trim().toLowerCase());
  return traceClient
    ? { traceClient, publicClient: traceClient === "claude" ? "claude-code" : traceClient }
    : undefined;
}

function traceClientFromPublicValue(value: unknown): MemoryViewerClient | undefined {
  if (value === "codex" || value === "dsh" || value === "opencode") return value;
  return value === "claude" || value === "claude-code" || value === "cc"
    ? "claude"
    : undefined;
}

function activeMemoryViewerProjects(
  projects: MemoryViewerProjectCatalogEntry[],
  projectSessions: MemoryViewerProjectSessionCatalogEntry[],
  activeSessionSince: number,
): MemoryViewerProjectCatalogEntry[] {
  const activeProjectIds = new Set(projectSessions
    .filter((entry) => {
      const lastSeenAt = Date.parse(entry.lastSeenAt);
      return Number.isFinite(lastSeenAt) && lastSeenAt >= activeSessionSince;
    })
    .map((entry) => entry.projectId));
  return projects.filter((entry) => activeProjectIds.has(entry.projectId));
}

function memoryViewerActivityCutoff(now: number): number {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  return Math.floor(safeNow / MEMORY_VIEWER_ACTIVITY_CUTOFF_GRANULARITY_MS)
    * MEMORY_VIEWER_ACTIVITY_CUTOFF_GRANULARITY_MS
    - MEMORY_VIEWER_SESSION_ACTIVITY_WINDOW_MS;
}

function conditionalViewerJson(req: IncomingMessage, res: ViewerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(payload).digest("base64url")}"`;
  const headers = {
    "cache-control": "private, no-cache",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "content-type": "application/json" });
  res.end(payload);
}

function projectFilter(url: URL): {
  projectId?: string;
  reject?: boolean;
} {
  const rawProjectId = url.searchParams.get("projectId");
  const projectId = (rawProjectId ?? "").trim();
  if (projectId === UNCLASSIFIED_PROJECT_ID || isMemoryProjectId(projectId)) {
    return { projectId };
  }
  if (rawProjectId !== null && projectId) return { reject: true };
  return {};
}

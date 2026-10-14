import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedClients } from "./client-selection.js";
import { LIFECYCLE_CLIENTS } from "./client-reports.js";

// This marker conservatively tracks cleanup scope, including partially prepared
// clients. Readiness is checked separately; mutations require the lifecycle lock.
export function readActiveManagedClients(memoraxCodeHome: string): ManagedClients | undefined {
  const path = activeManagedClientsPath(memoraxCodeHome);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof value.codex !== "boolean" || typeof value.claude !== "boolean") return undefined;
    if (LIFECYCLE_CLIENTS.some(({ id }) => value[id] !== undefined && typeof value[id] !== "boolean")) return undefined;
    return {
      codex: value.codex,
      claude: value.claude,
      // Records written before DSH became a Backend participant cannot claim
      // that the Backend was serving DSH.
      dsh: value.dsh === true,
      opencode: value.opencode === true,
      ...(value.codebuddy === true ? { codebuddy: true } : {}),
      ...(typeof value.workbuddy === "boolean" ? { workbuddy: value.workbuddy } : {}),
      ...(value.trae === true ? { trae: true } : {}),
      ...(value.cursor === true ? { cursor: true } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeActiveManagedClients(memoraxCodeHome: string, clients: ManagedClients): void {
  const path = activeManagedClientsPath(memoraxCodeHome);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    // An explicit new CLI selection must not look like the old WorkBuddy alias
    // when a later Hook recovers the retained client set.
    const record = { ...clients, ...(clients.codebuddy ? { workbuddy: clients.workbuddy === true } : {}) };
    writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function clearActiveManagedClients(memoraxCodeHome: string): void {
  rmSync(activeManagedClientsPath(memoraxCodeHome), { force: true });
}

function activeManagedClientsPath(memoraxCodeHome: string): string {
  return join(memoraxCodeHome, "runtime", "backend", "managed-clients.json");
}

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedClients } from "./client-selection.js";

export function readActiveManagedClients(memoraxCodeHome: string): ManagedClients | undefined {
  const path = activeManagedClientsPath(memoraxCodeHome);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof value.codex !== "boolean" || typeof value.claude !== "boolean") return undefined;
    if (value.opencode !== undefined && typeof value.opencode !== "boolean") return undefined;
    if (value.dsh !== undefined && typeof value.dsh !== "boolean") return undefined;
    return {
      codex: value.codex,
      claude: value.claude,
      // Records written before DSH became a Backend participant cannot claim
      // that the Backend was serving DSH.
      dsh: value.dsh === true,
      opencode: value.opencode === true,
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
    writeFileSync(temporaryPath, `${JSON.stringify(clients, null, 2)}\n`, "utf8");
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

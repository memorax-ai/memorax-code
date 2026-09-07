import { loadLifecycleMemoraxCodeConfig, type MemoraxCodeConfig } from "../config/memorax-code.js";
import { LIFECYCLE_CLIENTS, type LifecycleClientId } from "./client-reports.js";

// Preserve explicit false fields in legacy selection records. Later clients
// remain absent unless selected; this is distinct from discovery defaults.
const LEGACY_SELECTION_CLIENTS = ["codex", "claude", "dsh", "opencode"] as const;
type LegacySelectionClient = typeof LEGACY_SELECTION_CLIENTS[number];
export type ManagedClients = Readonly<Record<LegacySelectionClient, boolean>
  & Partial<Record<Exclude<LifecycleClientId, LegacySelectionClient>, boolean>>>;

const allClients: ManagedClients = Object.freeze(Object.fromEntries(
  LIFECYCLE_CLIENTS.map(({ id }) => [id, true]),
) as ManagedClients);

export function resolveManagedClients(argv: readonly string[], config: MemoraxCodeConfig = {}): ManagedClients {
  const explicit = argValue(argv, "--clients");
  if (explicit !== undefined) return parseManagedClients(explicit);

  if (config.clients !== undefined) {
    return {
      codex: config.clients.codex === true,
      claude: config.clients.claude === true,
      // DSH was added after the original clients table. An omitted value keeps
      // automatic local-Harness discovery enabled for existing installations.
      dsh: config.clients.dsh !== false,
      opencode: config.clients.opencode === true,
      ...(config.clients.codebuddy === true ? { codebuddy: true } : {}),
      ...(config.clients.trae === true ? { trae: true } : {}),
    };
  }

  return { codex: true, claude: true, dsh: true, opencode: true };
}

export function parseManagedClients(value: string): ManagedClients {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return allClients;
  if (normalized === "none") return { codex: false, claude: false, dsh: false, opencode: false };

  const names = normalized.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0 || names.some((name) => !LIFECYCLE_CLIENTS.some(({ id }) => id === name))) {
    throw new Error(`invalid --clients value: ${value}; expected a comma-separated subset of ${LIFECYCLE_CLIENTS.map(({ id }) => id).join(", ")}, or all or none`);
  }
  return Object.fromEntries(LIFECYCLE_CLIENTS
    .filter(({ id }) => LEGACY_SELECTION_CLIENTS.some((legacy) => legacy === id) || names.includes(id))
    .map(({ id }) => [id, names.includes(id)])) as ManagedClients;
}

export function loadManagedClientsConfig(memoraxCodeHome: string): MemoraxCodeConfig {
  return loadLifecycleMemoraxCodeConfig(memoraxCodeHome);
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : undefined;
}

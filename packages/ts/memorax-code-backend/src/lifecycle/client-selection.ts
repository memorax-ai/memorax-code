import { loadLifecycleMemoraxCodeConfig, type MemoraxCodeConfig } from "../config/memorax-code.js";

export type ManagedClients = Readonly<{
  codex: boolean;
  claude: boolean;
  dsh: boolean;
  opencode: boolean;
}>;

const allClients: ManagedClients = Object.freeze({ codex: true, claude: true, dsh: true, opencode: true });

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
    };
  }

  return allClients;
}

export function parseManagedClients(value: string): ManagedClients {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return allClients;
  if (normalized === "none") return { codex: false, claude: false, dsh: false, opencode: false };

  const names = normalized.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0 || names.some((name) => (
    name !== "codex" && name !== "claude" && name !== "dsh" && name !== "opencode"
  ))) {
    throw new Error(`invalid --clients value: ${value}; expected a comma-separated subset of codex, claude, dsh, opencode, or all or none`);
  }
  return {
    codex: names.includes("codex"),
    claude: names.includes("claude"),
    dsh: names.includes("dsh"),
    opencode: names.includes("opencode"),
  };
}

export function loadManagedClientsConfig(memoraxCodeHome: string): MemoraxCodeConfig {
  return loadLifecycleMemoraxCodeConfig(memoraxCodeHome);
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : undefined;
}

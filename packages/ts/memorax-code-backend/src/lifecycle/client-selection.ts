import { loadLifecycleMemoraxCodeConfig, type MemoraxCodeConfig } from "../config/memorax-code.js";

export type ManagedClients = Readonly<{
  codex: boolean;
  claude: boolean;
}>;

const allClients: ManagedClients = Object.freeze({ codex: true, claude: true });

export function resolveManagedClients(argv: readonly string[], config: MemoraxCodeConfig = {}): ManagedClients {
  const explicit = argValue(argv, "--clients");
  if (explicit !== undefined) return parseManagedClients(explicit);

  if (config.clients !== undefined) {
    return {
      codex: config.clients.codex === true,
      claude: config.clients.claude === true,
    };
  }

  return allClients;
}

export function parseManagedClients(value: string): ManagedClients {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return allClients;
  if (normalized === "none") return { codex: false, claude: false };

  const names = normalized.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0 || names.some((name) => name !== "codex" && name !== "claude")) {
    throw new Error(`invalid --clients value: ${value}; expected codex, claude, codex,claude, all, or none`);
  }
  return {
    codex: names.includes("codex"),
    claude: names.includes("claude"),
  };
}

export function loadManagedClientsConfig(memoraxCodeHome: string): MemoraxCodeConfig {
  return loadLifecycleMemoraxCodeConfig(memoraxCodeHome);
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : undefined;
}

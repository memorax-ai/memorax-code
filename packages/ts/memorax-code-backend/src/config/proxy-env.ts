const LOOPBACK_NO_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1"];

export function withLoopbackProxyBypass(env: NodeJS.ProcessEnv = process.env, backendUrl?: string): NodeJS.ProcessEnv {
  const hosts = loopbackProxyBypassHosts(backendUrl);
  if (hosts.length === 0) return { ...env };
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const value of [env.NO_PROXY, env.no_proxy]) {
    for (const entry of splitNoProxy(value)) addEntry(entries, seen, entry);
  }
  for (const host of hosts) addEntry(entries, seen, host);
  const merged = entries.join(",");
  return {
    ...env,
    NO_PROXY: merged,
    no_proxy: merged,
  };
}

function loopbackProxyBypassHosts(backendUrl?: string): string[] {
  if (!backendUrl) return [...LOOPBACK_NO_PROXY_HOSTS];
  try {
    const host = normalizeHost(new URL(backendUrl).hostname);
    if (!isLoopbackHost(host)) return [];
    return [...new Set([...LOOPBACK_NO_PROXY_HOSTS, host])];
  } catch {
    return [...LOOPBACK_NO_PROXY_HOSTS];
  }
}

function splitNoProxy(value: string | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function addEntry(entries: string[], seen: Set<string>, entry: string): void {
  const key = entry.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

function normalizeHost(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost"
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

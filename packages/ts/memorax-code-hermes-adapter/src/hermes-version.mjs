export const HERMES_TESTED_VERSIONS = Object.freeze(["0.20.3"]);

export function parseHermesVersion(output) {
  if (typeof output !== "string") return undefined;
  const banner = /^Hermes Agent v(\d+\.\d+\.\d+)(?:\s|$)/.exec(output);
  if (banner) return banner[1];
  const bare = /^v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(output.trim());
  return bare?.[1];
}

export function isTestedHermesVersion(version) {
  return HERMES_TESTED_VERSIONS.includes(version);
}

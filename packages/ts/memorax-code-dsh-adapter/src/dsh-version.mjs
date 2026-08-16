export const DSH_SUPPORTED_VERSIONS = Object.freeze(["0.1.0-rc.6"]);

export function isSupportedDshVersion(value) {
  return typeof value === "string" && DSH_SUPPORTED_VERSIONS.includes(value);
}

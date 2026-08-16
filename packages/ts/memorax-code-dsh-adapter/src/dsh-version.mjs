export const DSH_TESTED_VERSIONS = Object.freeze(["0.1.0-rc.6"]);

const DSH_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DSH_VERSION_MAX_LENGTH = 128;

export function parseDshVersion(value) {
  const version = typeof value === "string" ? value.trim() : "";
  return version
    && version.length <= DSH_VERSION_MAX_LENGTH
    && DSH_VERSION_PATTERN.test(version)
    ? version
    : undefined;
}

export function isTestedDshVersion(value) {
  const version = parseDshVersion(value);
  return version !== undefined && DSH_TESTED_VERSIONS.includes(version);
}

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const layoutCode = "WORKBUDDY_BUNDLE_LAYOUT_INVALID";
const runtimeCode = "WORKBUDDY_BUNDLE_RUNTIME_VERSION_MISMATCH";
function requireValue(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = (value) => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && !/[\r\n]/.test(value);

export function workBuddyRuntimeVersion(metadata, expectedVersion = null) {
  requireValue(object(metadata) && object(metadata.publishConfig) && object(metadata.bin)
    && metadata.bin.codebuddy === "./bin/codebuddy", layoutCode);
  const publish = metadata.publishConfig;
  const legacy = Object.hasOwn(publish, "customPackage"), current = Object.hasOwn(publish, "name");
  requireValue(legacy || current, layoutCode);
  if (legacy) requireValue(object(publish.customPackage)
    && publish.customPackage.name === "@tencent-ai/codebuddy-code", layoutCode);
  if (current) requireValue(publish.name === "@tencent-ai/codebuddy-code", layoutCode);
  // Legacy packages may have a different internal top-level version.
  const versions = [...(legacy ? [publish.customPackage.version] : []), ...(current ? [metadata.version] : [])];
  requireValue(versions.every(stable) && versions.every((value) => value === versions[0]), runtimeCode);
  requireValue(expectedVersion === null || (stable(expectedVersion) && versions[0] === expectedVersion), runtimeCode);
  return versions[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireValue(process.argv.length === 4, layoutCode);
    const metadata = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const runtimeVersion = workBuddyRuntimeVersion(metadata, process.argv[3] === "discover" ? null : process.argv[3]);
    console.log(JSON.stringify({ ok: true, runtimeVersion }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code === runtimeCode ? runtimeCode : layoutCode }));
    process.exitCode = 1;
  }
}

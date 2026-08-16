import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_LIB = dirname(fileURLToPath(import.meta.url));
const stagedLifecycle = join(
  PACKAGE_LIB,
  "memorax-code-dsh-adapter",
  "src",
  "profile-lifecycle.mjs",
);
const sourceLifecycle = resolve(
  PACKAGE_LIB,
  "../../../ts/memorax-code-dsh-adapter/src/profile-lifecycle.mjs",
);
const lifecycle = await import(
  pathToFileURL(existsSync(stagedLifecycle) ? stagedLifecycle : sourceLifecycle).href
);

export const collectDshAdapterStatus = lifecycle.collectDshAdapterStatus;
export const discoverDshProfiles = lifecycle.discoverDshProfiles;
export const withDshPluginLifecycleLock = lifecycle.withDshPluginLifecycleLock;

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageLib = dirname(fileURLToPath(import.meta.url));
const stagedLifecycle = join(
  packageLib,
  "memorax-code-dsh-adapter",
  "src",
  "profile-lifecycle.mjs",
);
const sourceLifecycle = resolve(
  packageLib,
  "../../../ts/memorax-code-dsh-adapter/src/profile-lifecycle.mjs",
);
const lifecycle = await import(
  pathToFileURL(existsSync(stagedLifecycle) ? stagedLifecycle : sourceLifecycle).href
);

export const collectDshAdapterStatus = lifecycle.collectDshAdapterStatus;
export const discoverDshProfiles = lifecycle.discoverDshProfiles;
export const withDshPluginLifecycleLock = lifecycle.withDshPluginLifecycleLock;

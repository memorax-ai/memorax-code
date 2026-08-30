import { join, resolve } from "node:path";
import {
  startAutomaticUpdateScheduler,
  type AutomaticUpdateScheduler,
  type AutomaticUpdateSchedulerRuntime,
} from "../../../memorax-code-adapter-common/src/hooks/automatic-update-scheduler.mjs";

export type { AutomaticUpdateScheduler };

export function startBackendAutomaticUpdateScheduler(
  options: {
    env?: NodeJS.ProcessEnv;
    memoraxCodeHome: string;
    packageRoot?: string;
    packageVersion?: string;
    debug?: (message: string) => void;
  },
  runtime?: AutomaticUpdateSchedulerRuntime,
): AutomaticUpdateScheduler | undefined {
  const packageRoot = nonEmptyString(options.packageRoot);
  const packageVersion = nonEmptyString(options.packageVersion);
  if (!packageRoot || !packageVersion) return undefined;
  const env = options.env ?? process.env;
  return startAutomaticUpdateScheduler({
    automaticUpdateProcess: env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS === "1",
    automaticUpdateValue: env.MEMORAX_CODE_AUTO_UPDATE,
    debug: options.debug,
    env,
    installedVersion: packageVersion,
    memoraxCodeCommand: join(resolve(packageRoot), "bin", "memorax-code.mjs"),
    memoraxCodeHome: options.memoraxCodeHome,
    nodePath: process.execPath,
  }, runtime);
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

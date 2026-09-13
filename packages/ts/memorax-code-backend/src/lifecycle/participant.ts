import type { BackendServiceOptions } from "./contracts.js";
import type { DeploymentFailure } from "../../../memorax-code-adapter-common/src/deployment-failure.mjs";

export type AdapterReport = {
  failure?: DeploymentFailure;
  ok?: boolean;
  action?: string;
  installed?: boolean;
  enabled?: boolean;
  managed?: boolean;
  integration?: string;
  runtime?: string;
  compatible?: boolean;
  version?: string;
  dshVersion?: string;
  dshVersionTested?: boolean;
  testedDshVersions?: string[];
  profiles?: unknown[];
  detectedProfiles?: string[];
  installedProfiles?: string[];
  removedProfiles?: string[];
  failedProfiles?: unknown[];
  authorityEnabled?: boolean;
  previouslyEnabled?: boolean;
  revision?: string;
  removed?: boolean;
  statePath?: string;
  changed?: boolean;
  skipped?: boolean;
  optional?: true;
  reason?: string;
  message?: string;
  error?: string;
  errorCode?: string;
  stage?: string;
  memoraxCodeHome?: string;
  codexHome?: string;
  openCodeConfigDir?: string;
  installPath?: string;
  pluginPath?: string;
  skillPath?: string;
  state?: {
    version?: number;
    enabled?: boolean;
    integration?: string;
    backendUrl?: string;
  };
  configuredBackendUrl?: string;
  expectedBackendUrl?: string;
  backendUrlMatches?: boolean;
  codexSkills?: { ok?: boolean; status?: string };
  claudeSkills?: { ok?: boolean; status?: string };
  opencodeSkills?: { ok?: boolean; status?: string };
  codebuddySkills?: { ok?: boolean; status?: string };
  traeSkills?: { ok?: boolean; status?: string };
  codebuddyHooks?: {
    ok?: boolean;
    status?: string;
    configured?: boolean;
    runtimeObserved?: boolean;
    observationPath?: string;
  };
  traeHooks?: {
    ok?: boolean;
    status?: string;
    configured?: boolean;
    runtimeObserved?: boolean;
    observationPath?: string;
  };
  globalHooksActivationRequired?: boolean;
  pluginInstall?: AdapterPluginLifecycleReport;
  pluginRemove?: AdapterPluginLifecycleReport;
  pluginStatus?: AdapterReport;
};

export type AdapterPluginLifecycleReport = {
  failure?: DeploymentFailure;
  ok: boolean;
  action?: string;
  reason?: string;
  message?: string;
  installPath?: string;
};

export type AdapterLifecycleContext = Readonly<{
  argv: string[];
  serviceOptions: BackendServiceOptions;
}>;

export type AdapterLifecycleBackendContext = AdapterLifecycleContext & Readonly<{
  backendUrl: string;
}>;

// Mutating phases run under the caller's Backend lifecycle lock; participant
// locks, when needed, are acquired inside it.
export type AdapterLifecycleParticipant<RemoveReport> = Readonly<{
  status(context: AdapterLifecycleBackendContext): Promise<AdapterReport>;
  // Native installation may already enable Hooks; this is not a pure staging phase.
  prepareEnable(context: AdapterLifecycleBackendContext): Promise<AdapterReport>;
  // Start activates gated runtime authority after Backend readiness. Rollback
  // can also use this phase to restore previously enabled authority.
  activate?(context: AdapterLifecycleContext): Promise<AdapterReport>;
  // Suspend recovery authority before Backend shutdown while retaining artifacts.
  quiesce?(context: AdapterLifecycleContext): Promise<AdapterReport>;
  disable(context: AdapterLifecycleContext): Promise<AdapterReport>;
  remove(context: AdapterLifecycleContext): Promise<RemoveReport>;
}>;

import type { BackendServiceOptions } from "./contracts.js";

export type AdapterReport = {
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
  pluginInstall?: AdapterPluginLifecycleReport;
  pluginRemove?: AdapterPluginLifecycleReport;
  pluginStatus?: AdapterReport;
};

export type AdapterPluginLifecycleReport = {
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

export type AdapterLifecycleParticipant<RemoveReport> = Readonly<{
  status(context: AdapterLifecycleBackendContext): Promise<AdapterReport>;
  prepareEnable(context: AdapterLifecycleBackendContext): Promise<AdapterReport>;
  activate?(context: AdapterLifecycleContext): Promise<AdapterReport>;
  quiesce?(context: AdapterLifecycleContext): Promise<AdapterReport>;
  disable(context: AdapterLifecycleContext): Promise<AdapterReport>;
  remove(context: AdapterLifecycleContext): Promise<RemoveReport>;
}>;

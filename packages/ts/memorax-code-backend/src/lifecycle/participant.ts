import type { BackendServiceOptions } from "./contracts.js";

export type AdapterReport = {
  ok?: boolean;
  action?: string;
  installed?: boolean;
  enabled?: boolean;
  managed?: boolean;
  integration?: string;
  statePath?: string;
  changed?: boolean;
  skipped?: boolean;
  reason?: string;
  message?: string;
  error?: string;
  memoraxCodeHome?: string;
  codexHome?: string;
  installPath?: string;
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
  disable(context: AdapterLifecycleContext): Promise<AdapterReport>;
  remove(context: AdapterLifecycleContext): Promise<RemoveReport>;
}>;

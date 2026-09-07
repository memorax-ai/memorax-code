import type { AdapterReport } from "./participant.js";

// Lifecycle names and legacy report fields are independent of Hook wire IDs.
export const LIFECYCLE_CLIENTS = [
  { id: "codex", name: "Codex", reportKey: "codexAdapter", skillKey: "codexSkills", hookKey: undefined },
  { id: "claude", name: "Claude Code", reportKey: "claudeAdapter", skillKey: "claudeSkills", hookKey: undefined },
  { id: "dsh", name: "DSH", reportKey: "dshAdapter", skillKey: undefined, hookKey: undefined },
  { id: "opencode", name: "OpenCode", reportKey: "opencodeAdapter", skillKey: "opencodeSkills", hookKey: undefined },
  { id: "codebuddy", name: "CodeBuddy/WorkBuddy", reportKey: "codebuddyAdapter", skillKey: "codebuddySkills", hookKey: "codebuddyHooks" },
  { id: "trae", name: "Trae", reportKey: "traeAdapter", skillKey: "traeSkills", hookKey: "traeHooks" },
] as const;

export type LifecycleClient = typeof LIFECYCLE_CLIENTS[number];
export type LifecycleClientId = LifecycleClient["id"];
export type ClientAdapterReports = Partial<Record<LifecycleClient["reportKey"], AdapterReport>>;

export function lifecycleAdapterReports(reports: ClientAdapterReports): {
  client: LifecycleClient;
  report: AdapterReport;
}[] {
  return LIFECYCLE_CLIENTS.flatMap((client) => {
    const report = reports[client.reportKey];
    return report ? [{ client, report }] : [];
  });
}

export type AdapterReportSummary = Readonly<{
  ready: boolean;
  installed: boolean;
  enabled: boolean;
  integration?: string;
  skillStatus?: string;
  hookStatus?: string;
  configured?: boolean;
  runtimeObserved?: boolean;
  activationRequired: boolean;
}>;

// Project legacy reports without changing their public JSON or native authority.
export function summarizeAdapterReport(report: AdapterReport): AdapterReportSummary {
  const skills = LIFECYCLE_CLIENTS.flatMap(({ skillKey }) => {
    const value = skillKey ? report[skillKey] : undefined;
    return value ? [value] : [];
  });
  const hooks = LIFECYCLE_CLIENTS.flatMap(({ hookKey }) => {
    const value = hookKey ? report[hookKey] : undefined;
    return value ? [value] : [];
  });
  const integration = report.integration ?? report.state?.integration;
  const installed = report.installed === true;
  const enabled = report.enabled === true;
  return {
    ready: (integration === "hooks" || integration === "plugin")
      && report.ok !== false
      && installed
      && enabled
      && report.backendUrlMatches !== false
      && skills.every((skill) => skill.ok !== false)
      && hooks.every((hook) => hook.ok !== false),
    installed,
    enabled,
    integration,
    skillStatus: skills.find((skill) => skill.status !== undefined)?.status,
    hookStatus: hooks.find((hook) => hook.status !== undefined)?.status,
    configured: hooks.find((hook) => hook.configured !== undefined)?.configured,
    runtimeObserved: hooks.find((hook) => hook.runtimeObserved !== undefined)?.runtimeObserved,
    activationRequired: report.globalHooksActivationRequired === true,
  };
}

export function isAdapterReady(report: AdapterReport): boolean {
  return summarizeAdapterReport(report).ready;
}

export type DeploymentFailure = {
  stage: string;
  errorCode: string;
  systemCode?: string;
  failureReason?: string;
  commandExitCode?: number;
  commandSignal?: string;
  cleanupErrorCode?: string;
  cleanupSystemCode?: string;
};
export type DeploymentFailureOptions = {
  commandResult?: { status?: number | null; exitCode?: number | null; signal?: string | null; error?: unknown };
  cleanupError?: unknown;
  failureReason?: string;
};
export function deploymentFailure(error: unknown, stage: string, options?: DeploymentFailureOptions): DeploymentFailure;
export function attachDeploymentFailure<T>(error: T, stage: string, options?: DeploymentFailureOptions): T;
export function projectDeploymentFailure(value: unknown): DeploymentFailure | undefined;

export type DiagnosticRecordFields = {
  source: string;
  operation: string;
  stage: string;
  errorCode: string;
  error: string;
  impact: string;
  userAction: string;
  version: string;
  runtimeVersion: string;
  platform: string;
  client?: string;
  sessionHash?: string;
  turnHash?: string;
  systemCode?: string;
  failureReason?: string;
  recordReason?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  processState?: "not-started" | "stopped" | "running" | "unknown";
  cleanupErrorCode?: string;
  cleanupSystemCode?: string;
};

export type DiagnosticWriteResult = {
  id: string;
  recorded: boolean;
  path?: string;
  recordingError?: string;
};

export function writeDiagnosticRecord(home: string, fields: DiagnosticRecordFields): DiagnosticWriteResult;

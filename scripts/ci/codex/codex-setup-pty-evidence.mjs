import { systemCode } from "../shared/ci-evidence-projections.mjs";

// Only the helper's fixed disposal result can cross the private terminal boundary.
export function projectTerminalDisposal(value) {
  if (!value || !["not-created", "not-required-after-exit", "returned", "failed"].includes(value.status)
    || typeof value.exitObserved !== "boolean") return undefined;
  const result = { status: value.status, exitObserved: value.exitObserved };
  if (value.status === "failed") {
    result.errorCode = "PTY_RESOURCE_DISPOSE_FAILED";
    const nativeCode = systemCode(value.systemCode);
    if (nativeCode) result.systemCode = nativeCode;
  }
  return result;
}

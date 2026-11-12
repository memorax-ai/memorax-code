export const PACKAGE_TRANSITION_ID_ENV: "MEMORAX_CODE_PACKAGE_TRANSITION_ID";
export const PACKAGE_STOP_REVISION_ENV: "MEMORAX_CODE_PACKAGE_STOP_REVISION";
export function packageRecoveryTransitionId(env?: Record<string, string | undefined>): string | undefined;
export function readPackageRecoveryRevision(memoraxCodeHome: string): string;
export function assertPackageRecoveryRevision(memoraxCodeHome: string, expectedRevision: string): void;
export function writePackageRecoveryPermit(memoraxCodeHome: string, transitionId: string): void;
export function assertPackageRecoveryPermit(memoraxCodeHome: string, transitionId: string): void;
export function clearPackageRecoveryPermit(memoraxCodeHome: string): void;

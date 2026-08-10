import type { RuntimeRecordWriteRuntime } from "../../../../memorax-code-adapter-common/src/runtime-record.mjs";
import { backendServiceHome } from "../lock.js";
import {
  persistBackendTokenForHome,
  readBackendTokenForHome,
  writeBackendTokenForHome,
  type BackendTokenRecord,
} from "./token-record.js";
import type { BackendServiceOptions } from "../contracts.js";

export function readBackendToken(
  options: BackendServiceOptions = {},
): BackendTokenRecord | undefined {
  return readBackendTokenForHome(backendServiceHome(options));
}

export function writeBackendToken(
  options: BackendServiceOptions = {},
  rotate = false,
  runtime?: RuntimeRecordWriteRuntime,
): BackendTokenRecord {
  return writeBackendTokenForHome(backendServiceHome(options), rotate, runtime);
}

export function persistBackendToken(
  options: BackendServiceOptions,
  token: string,
  runtime?: RuntimeRecordWriteRuntime,
): BackendTokenRecord {
  return persistBackendTokenForHome(backendServiceHome(options), token, runtime);
}

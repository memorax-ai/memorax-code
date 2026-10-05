import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCursorWindowsInstalledApp } from "./cursor-app-windows-artifact.mjs";

const prefix = "CURSOR_APP_WINDOWS_ARTIFACT_";
function failure(suffix) { return Object.assign(new Error(prefix + suffix), { code: prefix + suffix }); }
function publicCode(error) {
  const code = error?.cleanupErrorCode ?? error?.code;
  return typeof code === "string" && /^CURSOR_APP_WINDOWS_ARTIFACT_[A-Z0-9_]{1,80}$/.test(code)
    ? code : prefix + "VALIDATION";
}

export async function readInstalledRelease(path) {
  let file;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw failure("RELEASE");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || stat.size <= 0 || stat.size > 16384) {
      throw failure("RELEASE");
    }
    file = await open(path, "r");
    const opened = await file.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw failure("RELEASE");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw failure("RELEASE");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } catch { throw failure("RELEASE"); }
  finally { await file?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    if (process.argv.length !== 6) throw failure("ARGUMENTS");
    const release = await readInstalledRelease(process.argv[2]);
    const result = await verifyCursorWindowsInstalledApp({ release, root: process.argv[3], profileRoot: process.argv[4],
      appDirectory: process.argv[5], signal: controller.signal });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(publicCode(error)); process.exitCode = 1; }
}

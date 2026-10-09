import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// Cursor's application data is separate from CURSOR_HOME, which owns Hooks
// and Skills. Resolve without opening the database or searching other profiles.
export function cursorDatabasePath({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  recordedPath,
} = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const override = env.MEMORAX_CODE_CURSOR_DATABASE_PATH !== undefined
    ? env.MEMORAX_CODE_CURSOR_DATABASE_PATH : recordedPath;
  if (override !== undefined) return absolutePath(override, paths);

  let userData;
  if (env.VSCODE_PORTABLE) {
    userData = paths.join(env.VSCODE_PORTABLE, "user-data");
  } else if (env.VSCODE_APPDATA) {
    userData = paths.join(env.VSCODE_APPDATA, "Cursor");
  } else if (platform === "darwin") {
    userData = paths.join(home, "Library", "Application Support", "Cursor");
  } else if (platform === "win32") {
    userData = paths.join(env.APPDATA || paths.join(env.USERPROFILE || home, "AppData", "Roaming"), "Cursor");
  } else if (platform === "linux") {
    userData = paths.join(env.XDG_CONFIG_HOME || paths.join(home, ".config"), "Cursor");
  } else {
    return undefined;
  }
  const root = absolutePath(userData, paths);
  return root ? paths.join(root, "User", "globalStorage", "state.vscdb") : undefined;
}

function absolutePath(value, paths) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value) || !paths.isAbsolute(value)) return undefined;
  if (paths === win32 && paths.parse(value).root.length === 1) return undefined;
  return paths.normalize(value);
}

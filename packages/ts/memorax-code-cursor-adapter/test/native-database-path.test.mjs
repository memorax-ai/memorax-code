import assert from "node:assert/strict";
import test from "node:test";
import { cursorDatabasePath } from "../src/native-database-path.mjs";

test("Cursor database defaults follow native platform application data, independently of CURSOR_HOME", () => {
  const env = { CURSOR_HOME: "/unrelated/hooks" };
  assert.equal(cursorDatabasePath({ env, home: "/isolated/user", platform: "darwin" }),
    "/isolated/user/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabasePath({ env, home: "/isolated/user", platform: "linux" }),
    "/isolated/user/.config/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabasePath({ env: { XDG_CONFIG_HOME: "/isolated/config" }, home: "/isolated/user", platform: "linux" }),
    "/isolated/config/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabasePath({ env: { APPDATA: "C:\\isolated\\appdata" }, home: "C:\\isolated\\user", platform: "win32" }),
    "C:\\isolated\\appdata\\Cursor\\User\\globalStorage\\state.vscdb");
  assert.equal(cursorDatabasePath({ env: {}, home: "C:\\isolated\\user", platform: "win32" }),
    "C:\\isolated\\user\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb");
});

test("Cursor database honors native portable/application-data roots and explicit override precedence", () => {
  const options = { home: "/isolated/user", platform: "linux" };
  const env = { VSCODE_PORTABLE: "/isolated/portable", VSCODE_APPDATA: "/isolated/appdata" };
  assert.equal(cursorDatabasePath({ ...options, env }),
    "/isolated/portable/user-data/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabasePath({ ...options, env: { VSCODE_APPDATA: env.VSCODE_APPDATA } }),
    "/isolated/appdata/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabasePath({ ...options, env, recordedPath: "/isolated/recorded/state.vscdb" }),
    "/isolated/recorded/state.vscdb");
  assert.equal(cursorDatabasePath({ ...options, recordedPath: "/isolated/recorded/state.vscdb",
    env: { ...env, MEMORAX_CODE_CURSOR_DATABASE_PATH: "/isolated/explicit/state.vscdb" } }),
  "/isolated/explicit/state.vscdb");
});

test("Cursor rejects invalid database overrides instead of falling back to another profile", () => {
  const options = { home: "/isolated/user", platform: "linux", recordedPath: "/isolated/recorded/state.vscdb" };
  for (const value of ["", " ", "relative/state.vscdb", "/isolated/invalid\npath", "/isolated/invalid\0path", "/isolated/invalid\tpath"]) {
    assert.equal(cursorDatabasePath({ ...options, env: { MEMORAX_CODE_CURSOR_DATABASE_PATH: value } }), undefined);
  }
  assert.equal(cursorDatabasePath({ ...options, env: {}, recordedPath: "relative" }), undefined);
  assert.equal(cursorDatabasePath({ ...options, recordedPath: undefined, env: { XDG_CONFIG_HOME: "relative" } }), undefined);
  assert.equal(cursorDatabasePath({ env: {}, home: "/isolated/user", platform: "unsupported" }), undefined);
  assert.equal(cursorDatabasePath({ platform: "win32", env: { MEMORAX_CODE_CURSOR_DATABASE_PATH: "\\current-drive\\state.vscdb" } }), undefined);
});

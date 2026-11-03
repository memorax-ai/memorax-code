import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { isOpenCodeDefaultWorkspace, isQoderManagedTaskWorkspace, resolveWorkBuddyWorkspaceKind } from "../src/default-workspace.mjs";

test("Qoder recognizes only a valid date and generated task directory under its native Documents root", () => {
  for (const platform of ["darwin", "linux"]) {
    const options = {
      platform,
      env: { HOME: "/home/test", USERPROFILE: "/different-home", QODER_HOME: "/custom-qoder", XDG_DOCUMENTS_DIR: "/custom-documents" },
      realpath: (path) => path,
    };
    for (const task of ["62e7b36b", "A", "task._-1"])
      assert.equal(isQoderManagedTaskWorkspace(`/home/test/Documents/Qoder/2024-02-29/${task}`, options), true);
    for (const cwd of [
      undefined, "", "Documents/Qoder/2026-10-06/62e7b36b",
      "/home/test/Documents/Qoder", "/home/test/Documents/Qoder/2026-10-06",
      "/home/test/Documents/Qoder/2026-10-06/62e7b36b/nested",
      "/home/test/Documents/Qoder/2026-02-29/62e7b36b",
      "/home/test/Documents/Qoder/2026-13-01/62e7b36b",
      "/home/test/Documents/Qoder/2026-01-32/62e7b36b",
      "/home/test/Documents/Qoder/2026-1-06/62e7b36b",
      "/home/test/Documents/Qoder/2026-10-06/123456789",
      "/home/test/Documents/Qoder/2026-10-06/.hidden",
      "/home/test/Documents/Qoder/2026-10-06/-task",
      "/home/test/Documents/Qoder/2026-10-06/task name",
      "/home/test/Documents/Qoder/2026-10-06/task:one",
      "/home/test/Documents/Qoder/2026-10-06/你好",
      "/home/test/Documents/Qoder/2026-10-06/62e7b36b ",
      " /home/test/Documents/Qoder/2026-10-06/62e7b36b",
      "/home/test/Documents/qoder/2026-10-06/62e7b36b",
      "/home/test/.qoderwork/2026-10-06/62e7b36b",
      "/different-home/Documents/Qoder/2026-10-06/62e7b36b",
      "/custom-qoder/2026-10-06/62e7b36b",
      "/custom-documents/Qoder/2026-10-06/62e7b36b",
    ]) assert.equal(isQoderManagedTaskWorkspace(cwd, options), false, `${platform}: ${cwd}`);
  }
});

test("Qoder Windows uses USERPROFILE without guessing alternate Documents roots", () => {
  const options = {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\Test", HOME: "D:\\Other", OneDrive: "E:\\Cloud" },
    realpath: win32.normalize,
  };
  assert.equal(isQoderManagedTaskWorkspace("c:/users/test/Documents/Qoder/2026-10-06/62e7b36b", options), true);
  for (const cwd of [
    "C:\\Users\\Test\\Documents\\Qoder",
    "C:\\Users\\Test\\Documents\\Qoder\\2026-10-06\\62e7b36b\\nested",
    "D:\\Other\\Documents\\Qoder\\2026-10-06\\62e7b36b",
    "E:\\Cloud\\Documents\\Qoder\\2026-10-06\\62e7b36b",
    "C:Documents\\Qoder\\2026-10-06\\62e7b36b",
  ]) assert.equal(isQoderManagedTaskWorkspace(cwd, options), false, cwd);
});

test("Qoder preserves cwd bytes and fails closed when either canonical path is unavailable", () => {
  const cwd = "/home/test/Documents/Qoder/2026-10-06/62e7b36b ";
  const calls = [];
  const options = {
    platform: "darwin", env: { HOME: "/home/test" },
    realpath: (path) => { calls.push(path); return path; },
  };
  assert.equal(isQoderManagedTaskWorkspace(cwd, options), false);
  assert.equal(calls[0], cwd);
  const task = cwd.trimEnd();
  for (const unavailable of [task, "/home/test/Documents/Qoder"]) {
    assert.equal(isQoderManagedTaskWorkspace(task, {
      ...options,
      realpath: (path) => {
        if (path === unavailable) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
        return path;
      },
    }), false);
  }
});

test("Qoder follows a redirected Documents root but rejects task and date symlinks escaping its managed root", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-qoder-workspace-"));
  try {
    const documents = join(home, "redirected-documents");
    const root = join(documents, "Qoder");
    const task = join(root, "2026-10-06", "62e7b36b");
    const outside = join(home, "ordinary-project");
    await mkdir(join(task, "nested"), { recursive: true });
    await mkdir(outside);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(documents, join(home, "Documents"), linkType);
    const options = { env: { HOME: home, USERPROFILE: home } };
    assert.equal(isQoderManagedTaskWorkspace(join(home, "Documents", "Qoder", "2026-10-06", "62e7b36b"), options), true);
    assert.equal(isQoderManagedTaskWorkspace(task, options), true);
    for (const cwd of [root, join(task, "nested"), join(root, "2026-10-06", "missing")])
      assert.equal(isQoderManagedTaskWorkspace(cwd, options), false, cwd);
    const escapedTask = join(root, "2026-10-06", "a1234567");
    await symlink(outside, escapedTask, linkType);
    assert.equal(isQoderManagedTaskWorkspace(escapedTask, options), false);
    const escapedDate = join(root, "2026-10-07");
    await mkdir(join(outside, "b1234567"));
    await symlink(outside, escapedDate, linkType);
    assert.equal(isQoderManagedTaskWorkspace(join(escapedDate, "b1234567"), options), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("WorkBuddy recognizes only an immediate valid task under the configured native root", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-workbuddy-workspace-"));
  const options = { env: { HOME: home, USERPROFILE: home } };
  try {
    const root = join(home, "WorkBuddy");
    const task = join(root, "2026-09-08-12-34-56");
    const invalid = join(root, "2026-02-30-12-34-56");
    const invalidTime = join(root, "2026-09-08-24-00-00");
    const ordinary = join(root, "my-project");
    const outside = join(home, "outside");
    for (const directory of [join(task, "nested"), invalid, invalidTime, ordinary, outside]) await mkdir(directory, { recursive: true });
    assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: task }, options), "projectless");
    for (const cwd of [root, join(task, "nested"), invalid, invalidTime, ordinary, outside, "WorkBuddy/2026-09-08-12-34-56"])
      assert.equal(resolveWorkBuddyWorkspaceKind({ cwd }, options), undefined, cwd);
    const escaped = join(root, "2026-09-08-12-34-57");
    await symlink(outside, escaped, process.platform === "win32" ? "junction" : "dir");
    assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: escaped }, options), undefined);
    assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: task, workspace_kind: "local", workspaceKind: "projectless" }, options), "local");

    const customRoot = join(home, "Custom tasks");
    const customTask = join(customRoot, "2026-09-08-12-34-56");
    const userData = join(home, "native-app");
    const configRoot = join(home, "native-config");
    await mkdir(customTask, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(join(configRoot, "app"), { recursive: true });
    await writeFile(join(configRoot, "app", "app-config.json"), JSON.stringify({ defaultWorkspacePath: customRoot }));
    const configOptions = { env: { ...options.env, WORKBUDDY_CONFIG_DIR: configRoot } };
    assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: customTask }, configOptions), "projectless");
    assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: task }, configOptions), undefined);
    await writeFile(join(userData, "app-config.json"), "invalid json");
    const userDataOptions = { env: { ...configOptions.env, WORKBUDDY_USER_DATA_DIR: userData } };
    assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: customTask }, userDataOptions), undefined);
    await writeFile(join(userData, "app-config.json"), JSON.stringify({ defaultWorkspacePath: customRoot }));
    assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: customTask }, userDataOptions), "projectless");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode follows redirected Documents but rejects nested projects and escaping project links", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-opencode-documents-"));
  try {
    const documents = join(home, "redirected-documents");
    const project = join(documents, "Default Project");
    await mkdir(join(project, "nested"), { recursive: true });
    await symlink(documents, join(home, "Documents"), process.platform === "win32" ? "junction" : "dir");
    const options = {
      env: { HOME: home, USERPROFILE: home, SystemRoot: "C:\\Windows" },
      execFile: () => `${join(home, "Documents")}\r\n`,
    };
    assert.equal(isOpenCodeDefaultWorkspace(join(home, "Documents", "Default Project"), options), true);
    assert.equal(isOpenCodeDefaultWorkspace(join(project, "nested"), options), false);
    assert.equal(isOpenCodeDefaultWorkspace(documents, options), false);
    await rm(project, { recursive: true });
    const outside = join(home, "ordinary-project");
    await mkdir(outside);
    await symlink(outside, project, process.platform === "win32" ? "junction" : "dir");
    assert.equal(isOpenCodeDefaultWorkspace(project, options), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Linux Documents reads XDG data without evaluating shell expressions or hiding unreadable configuration", () => {
  const base = { platform: "linux", env: { HOME: "/home/test", XDG_CONFIG_HOME: "/custom-config" }, realpath: (path) => path };
  const options = (text) => ({ ...base, readFile: (path) => { assert.equal(path, "/custom-config/user-dirs.dirs"); return text; } });
  assert.equal(isOpenCodeDefaultWorkspace("/home/test/My Documents/Default Project", options('XDG_DOCUMENTS_DIR="$HOME/My Documents"\n')), true);
  assert.equal(isOpenCodeDefaultWorkspace("/mnt/documents/Default Project", options('XDG_DOCUMENTS_DIR="/mnt/documents"\n')), true);
  for (const text of ['XDG_DOCUMENTS_DIR="$(touch /tmp/never-run)"', 'XDG_DOCUMENTS_DIR="$OTHER/documents"', 'XDG_DOCUMENTS_DIR=unquoted'])
    assert.equal(isOpenCodeDefaultWorkspace("/home/test/Documents/Default Project", options(text)), false);
  assert.equal(isOpenCodeDefaultWorkspace("/home/test/Documents/Default Project", { ...base, readFile: () => { throw Object.assign(new Error(), { code: "EACCES" }); } }), false);
});

test("Windows Documents queries the unique system folder in UTF-8 and never guesses after lookup failure", () => {
  const env = { USERPROFILE: "C:\\Users\\Test", SystemRoot: "C:\\Windows", OneDrive: "D:\\Cloud" };
  const base = { platform: "win32", env, realpath: win32.normalize };
  const options = {
    ...base,
    execFile: (executable, args, config) => {
      assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      assert.match(args[3], /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
      assert.match(args[3], /\[Environment\]::GetFolderPath\('MyDocuments'\)/);
      assert.equal(config.timeout, 1_000);
      assert.equal(config.encoding, "utf8");
      assert.equal(config.shell, undefined);
      return "D:\\云空间\\文档\r\n";
    },
  };
  assert.equal(isOpenCodeDefaultWorkspace("d:/云空间/文档/default project", options), true);
  assert.equal(isOpenCodeDefaultWorkspace("C:\\Users\\Test\\Documents\\Default Project", options), false);
  assert.equal(isOpenCodeDefaultWorkspace("D:\\Cloud\\Documents\\Default Project", options), false);
  assert.equal(isOpenCodeDefaultWorkspace("D:\\云空间\\文档\\Default Project\\nested", options), false);
  let calls = 0;
  const unavailable = { ...base, execFile: () => { calls += 1; throw new Error("folder query timeout"); } };
  assert.equal(isOpenCodeDefaultWorkspace("D:\\Cloud\\Documents\\Default Project", unavailable), false);
  assert.equal(isOpenCodeDefaultWorkspace("C:\\Users\\Test\\Documents\\Default Project", unavailable), false);
  assert.equal(isOpenCodeDefaultWorkspace("E:\\Unrelated\\Documents\\Default Project", unavailable), false);
  const lookups = calls;
  assert.equal(isOpenCodeDefaultWorkspace("D:\\ordinary-project", unavailable), false);
  assert.equal(isOpenCodeDefaultWorkspace("D:\\Cloud\\Documents\\Default Project\\nested", unavailable), false);
  assert.equal(calls, lookups, "ordinary workspaces do not launch a folder lookup");
  assert.equal(resolveWorkBuddyWorkspaceKind({ cwd: "d:/tasks/2026-09-08-12-34-56" }, {
    ...base,
    readFile: () => JSON.stringify({ defaultWorkspacePath: "D:\\Tasks" }),
  }), "projectless");
});

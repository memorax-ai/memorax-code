import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "workbuddy-macos-bundle-check.sh");
const posixOnly = { skip: process.platform === "win32" };
const hashes = {
  arm64: "251d3e56a940a6061752534e5466e7dab332d4ee06148824a569a739892e1c21",
  x64: "0bee8b10407eebbfff3e1a177bfc790f6c95f6cd66bceb5676fd13a709b5715b",
};
function latestRelease(arch = "arm64") {
  return { platform: `darwin-${arch}`, desktopVersion: "5.7.0.40000000", productVersion: "5.7.0",
    runtimeVersion: null, sha256: "a".repeat(64), channel: "latest",
    url: `https://download.codebuddy.cn/workbuddy/saas/darwin-${arch}/WorkBuddy-darwin-${arch}-5.7.0.40000000-abcdef12.dmg` };
}

test("WorkBuddy bundle acquisition rejects unsupported OS and architecture before downloading", posixOnly, async () => {
  for (const [os, machine, expected] of [["Linux", "arm64", "MACOS_REQUIRED"],
    ["Darwin", "riscv64", "ARCH_UNSUPPORTED"]]) {
    await fixture(async ({ run, calls, destination }) => {
      const result = await run([destination]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `WORKBUDDY_BUNDLE_${expected}\n`);
      assert.deepEqual(await calls(), []);
      assert.deepEqual(await readdir(destination), []);
    }, { os, machine });
  }
});

test("WorkBuddy bundle acquisition validates arguments and an empty real destination", posixOnly, async () => {
  await fixture(async ({ run, calls, root, destination }) => {
    for (const args of [[], [destination, "arm64", "extra", "extra"]]) {
      assert.match((await run(args)).stderr, /WORKBUDDY_BUNDLE_ARGUMENTS_INVALID/);
    }
    assert.match((await run([destination, "unknown"])).stderr, /WORKBUDDY_BUNDLE_ARCH_UNSUPPORTED/);
    assert.match((await run([join(root, "missing")])).stderr, /WORKBUDDY_BUNDLE_DESTINATION_INVALID/);
    const link = join(root, "link");
    await symlink(destination, link);
    assert.match((await run([link])).stderr, /WORKBUDDY_BUNDLE_DESTINATION_INVALID/);
    await writeFile(join(destination, ".keep"), "Existing data.\n");
    assert.match((await run([destination])).stderr, /WORKBUDDY_BUNDLE_DESTINATION_NOT_EMPTY/);
    assert.equal(await readFile(join(destination, ".keep"), "utf8"), "Existing data.\n");
    assert.deepEqual(await calls(), []);
  });
});

for (const [machine, arch] of [["arm64", "arm64"], ["x86_64", "x64"]]) {
  test(`WorkBuddy bundle acquisition pins the official ${arch} URL and full SHA-256`, posixOnly, async () => {
    await fixture(async ({ run, calls, curlArgs, destination }) => {
      const result = await run([destination]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        desktopVersion: "5.6.2.39298511", runtimeVersion: "2.147.0", arch,
        sha256: hashes[arch], file: "WorkBuddy.dmg",
      });
      assert.equal(result.stdout.includes(destination), false);
      assert.deepEqual(await calls(), ["curl", "shasum"]);
      assert.deepEqual(await curlArgs(), ["--disable", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "30", "--max-time", "600",
        "--retry", "2", "--retry-max-time", "900", "--output", join(destination, "WorkBuddy.dmg.partial"),
        `https://download.codebuddy.cn/workbuddy/saas/darwin-${arch}/WorkBuddy-darwin-${arch}-5.6.2.39298511-37a65c0b.dmg`]);
      assert.deepEqual(await readdir(destination), ["WorkBuddy.dmg"]);
      assert.equal(await readFile(join(destination, "WorkBuddy.dmg"), "utf8"), "Synthetic DMG.\n");
    }, { machine, hash: hashes[arch] });
  });
}

test("WorkBuddy bundle acquisition supports an explicit architecture without running the bundle", posixOnly, async () => {
  await fixture(async ({ run, calls, destination }) => {
    const result = await run([destination, "x64"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).arch, "x64");
    assert.deepEqual(await calls(), ["curl", "shasum"]);
  }, { hash: hashes.x64 });
});

for (const channel of ["baseline", "baseline+latest"]) {
  test(`WorkBuddy acquisition preserves exact runtime verification for a supplied ${channel} release`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination, releasePath }) => {
      const release = { platform: "darwin-arm64", desktopVersion: "5.6.2.39298511", productVersion: "5.6.2",
        runtimeVersion: "2.147.0", sha256: hashes.arm64, channel,
        url: "https://download.codebuddy.cn/workbuddy/saas/darwin-arm64/WorkBuddy-darwin-arm64-5.6.2.39298511-37a65c0b.dmg" };
      await writeFile(releasePath, JSON.stringify(release));
      const result = await run([destination, "arm64", releasePath]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { desktopVersion: release.desktopVersion,
        runtimeVersion: release.runtimeVersion, arch: "arm64", sha256: release.sha256, file: "WorkBuddy.dmg" });
      assert.deepEqual(await calls(), ["curl", "shasum"]);
    });
  });
}

for (const arch of ["arm64", "x64"]) {
  test(`WorkBuddy ${arch} latest acquisition verifies the frozen release without guessing its runtime`, posixOnly, async () => {
    const release = latestRelease(arch);
    await fixture(async ({ run, calls, curlArgs, destination, releasePath }) => {
      const result = await run([destination, arch, releasePath]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { desktopVersion: release.desktopVersion,
        runtimeVersion: null, arch, sha256: release.sha256, file: "WorkBuddy.dmg" });
      assert.equal((await curlArgs()).at(-1), release.url);
      assert.deepEqual(await calls(), ["curl", "shasum"]);
      assert.deepEqual(await readdir(destination), ["WorkBuddy.dmg"]);
    }, { release, hash: release.sha256 });
  });
}

for (const invalid of ["missing", "empty path", "malformed", "platform", "runtime", "url", "baseline override"]) {
  test(`WorkBuddy latest acquisition rejects ${invalid} release metadata before downloading`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination, releasePath }) => {
      const release = latestRelease();
      if (invalid === "platform") Object.assign(release, latestRelease("x64"));
      if (invalid === "runtime") release.runtimeVersion = "2.147.0";
      if (invalid === "url") release.url = "https://example.com/WorkBuddy.dmg";
      if (invalid === "baseline override") release.channel = "baseline";
      await writeFile(releasePath, invalid === "malformed" ? "{" : JSON.stringify(release));
      if (invalid === "missing") await rm(releasePath);
      const result = await run([destination, "arm64", invalid === "empty path" ? "" : releasePath]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "WORKBUDDY_BUNDLE_RELEASE_INVALID\n");
      assert.deepEqual(await calls(), []);
      assert.deepEqual(await readdir(destination), []);
    });
  });
}

test("WorkBuddy latest acquisition rejects the baseline digest for a different release", posixOnly, async () => {
  await fixture(async ({ run, calls, destination, releasePath }) => {
    const result = await run([destination, "arm64", releasePath]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "WORKBUDDY_BUNDLE_HASH_MISMATCH\n");
    assert.deepEqual(await calls(), ["curl", "shasum"]);
    assert.deepEqual(await readdir(destination), []);
  });
});

for (const [name, options, expected, expectedCalls] of [
  ["network failure", { curlExit: "22" }, "DOWNLOAD_FAILED", ["curl"]],
  ["checksum mismatch", { hash: "0".repeat(64) }, "HASH_MISMATCH", ["curl", "shasum"]],
  ["checksum tool failure", { hashExit: "1" }, "HASH_FAILED", ["curl", "shasum"]],
]) {
  test(`WorkBuddy bundle acquisition stops and removes partial data after ${name}`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination }) => {
      const result = await run([destination]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `WORKBUDDY_BUNDLE_${expected}\n`);
      assert.deepEqual(await calls(), expectedCalls);
      assert.deepEqual(await readdir(destination), []);
    }, options);
  });
}

async function fixture(callback, { os = "Darwin", machine = "arm64", hash = hashes.arm64,
  curlExit = "0", hashExit = "0", release = latestRelease() } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbuddy-bundle-check-")));
  const bin = join(root, "bin"), destination = join(root, "download");
  const callLog = join(root, "calls"), curlLog = join(root, "curl-args");
  const releasePath = join(root, "release.json");
  try {
    await Promise.all([bin, destination, join(root, "home"), join(root, "tmp")].map((path) => mkdir(path)));
    await writeFile(releasePath, JSON.stringify(release));
    const stubs = {
      uname: 'case "$1" in -s) printf "%s\\n" "$FAKE_OS" ;; -m) printf "%s\\n" "$FAKE_MACHINE" ;; *) exit 1 ;; esac',
      curl: `printf 'curl\\n' >> "$FAKE_CALLS"
printf '%s\\n' "$@" > "$FAKE_CURL_ARGS"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output="$2"; break; fi
  shift
done
printf 'Synthetic DMG.\\n' > "$output"
exit "$FAKE_CURL_EXIT"`,
      shasum: `printf 'shasum\\n' >> "$FAKE_CALLS"
[[ $# -eq 3 && "$1" == -a && "$2" == 256 && "$3" == */WorkBuddy.dmg.partial ]] || exit 2
printf '%s  %s\\n' "$FAKE_HASH" "$3"
exit "$FAKE_HASH_EXIT"`,
    };
    for (const [name, source] of Object.entries(stubs)) {
      const path = join(bin, name);
      await writeFile(path, `#!/bin/bash\nset -eu\n${source}\n`);
      await chmod(path, 0o755);
    }
    const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
      MEMORAX_CODE_HOME: join(root, "state"), FAKE_OS: os, FAKE_MACHINE: machine, FAKE_HASH: hash,
      FAKE_CURL_EXIT: curlExit, FAKE_HASH_EXIT: hashExit, FAKE_CALLS: callLog, FAKE_CURL_ARGS: curlLog };
    const lines = async (path) => {
      try { return (await readFile(path, "utf8")).trimEnd().split("\n"); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    };
    const run = async (args) => {
      try { return { code: 0, ...await execute("/bin/bash", [script, ...args], { env, cwd: root, timeout: 10_000 }) }; }
      catch (error) {
        if (typeof error.code !== "number") throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    };
    await callback({ root, destination, releasePath, run, calls: () => lines(callLog), curlArgs: () => lines(curlLog) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

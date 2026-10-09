import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "workbuddy-linux-bundle-check.sh");
const posixOnly = { skip: process.platform === "win32" };
const sha256 = "2ef1bca217d29d9c2ba988c82079aa6ea0077e9f1ff882c6ab5dd7998bddf721";
const cliRelative = "opt/WorkBuddy/resources/app.asar.unpacked/cli";
const fields = ["Package", "Version", "Architecture"];
const latestRelease = { platform: "linux-x64-deb", desktopVersion: "5.7.0.40000000", productVersion: "5.7.0",
  runtimeVersion: null, sha256: "a".repeat(64), channel: "latest",
  url: "https://download.codebuddy.cn/workbuddy/saas/linux-x64-deb/WorkBuddy-linux-x64-deb-5.7.0.40000000-abcdef12.deb" };

function diagnosticLine(overrides = {}) {
  return `WORKBUDDY_BUNDLE_DIAGNOSTIC ${JSON.stringify({ expectedSha256: sha256, actualSha256: null,
    bytes: 15, curlExit: 0, httpStatus: 200, contentLength: 15, contentRange: null, ...overrides })}\n`;
}

function hashWarning(actualSha256, expectedSha256 = sha256) {
  return "::warning::WORKBUDDY_BUNDLE_HASH_MISMATCH_WARNING: Linux CI will continue only after package and runtime validation.\n"
    + diagnosticLine({ actualSha256, expectedSha256 });
}

test("WorkBuddy Linux acquisition rejects unsupported OS and architecture before downloading", posixOnly, async () => {
  for (const [os, machine, expected] of [["Darwin", "x86_64", "LINUX_REQUIRED"],
    ["Linux", "aarch64", "ARCH_UNSUPPORTED"]]) {
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

test("WorkBuddy Linux acquisition requires an empty real destination and valid arguments", posixOnly, async () => {
  await fixture(async ({ run, calls, root, destination }) => {
    for (const args of [[], [destination, "x64", "extra", "extra"]]) {
      assert.match((await run(args)).stderr, /WORKBUDDY_BUNDLE_ARGUMENTS_INVALID/);
    }
    assert.match((await run([destination, "arm64"])).stderr, /WORKBUDDY_BUNDLE_ARCH_UNSUPPORTED/);
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

for (const args of [[], ["x64"]]) {
  test(`WorkBuddy Linux acquisition validates and extracts the official x64 bundle (${args.length ? "explicit" : "detected"})`, posixOnly, async () => {
    await fixture(async ({ run, calls, curlArgs, dpkgArgs, destination }) => {
      const result = await run([destination, ...args]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        desktopVersion: "5.5.6.38337834", runtimeVersion: "2.137.1", arch: "x64", sha256,
        command: `extracted/${cliRelative}/bin/codebuddy`,
      });
      assert.equal(result.stdout.includes(destination), false);
      assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
      assert.deepEqual(await curlArgs(), ["--disable", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "30", "--max-time", "600",
        "--retry", "2", "--retry-max-time", "900",
        "--write-out", "%{http_code}\\n%header{content-length}\\n%header{content-range}\\n%{url_effective}\\n%{num_redirects}\\n%header{etag}\\n%header{last-modified}\\n%header{content-encoding}\\n",
        "--output", join(destination, "WorkBuddy.deb.partial"),
        "https://download.codebuddy.cn/workbuddy/saas/linux-x64-deb/WorkBuddy-linux-x64-deb-5.5.6.38337834-5f969292.deb"]);
      assert.deepEqual(await dpkgArgs(), fields.flatMap((field) => ["--field", join(destination, "WorkBuddy.deb.partial"), field])
        .concat(["-x", join(destination, "WorkBuddy.deb"), join(destination, "extracted")]));
      assert.deepEqual(await readdir(destination), ["WorkBuddy.deb", "extracted"]);
      assert.equal(await readFile(join(destination, "WorkBuddy.deb"), "utf8"), "Synthetic deb.\n");
    });
  });
}

test("WorkBuddy Linux latest acquisition discovers the bundled runtime after a hash warning", posixOnly, async () => {
  const actualSha256 = "b".repeat(64);
  await fixture(async ({ run, calls, curlArgs, destination, releasePath, metadata, packageRoot }) => {
    metadata.publishConfig.customPackage.version = "2.160.1";
    await writeFile(join(packageRoot, cliRelative, "package.json"), JSON.stringify(metadata));
    const result = await run([destination, "x64", releasePath]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, hashWarning(actualSha256, latestRelease.sha256));
    assert.deepEqual(JSON.parse(result.stdout), { desktopVersion: latestRelease.desktopVersion,
      runtimeVersion: "2.160.1", arch: "x64", sha256: actualSha256,
      command: `extracted/${cliRelative}/bin/codebuddy` });
    assert.equal((await curlArgs()).at(-1), latestRelease.url);
    assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
    assert.deepEqual(await readdir(destination), ["WorkBuddy.deb", "extracted"]);
  }, { hash: actualSha256, packageVersion: latestRelease.productVersion });
});

for (const channel of ["baseline", "baseline+latest"]) {
  test(`WorkBuddy Linux acquisition preserves exact runtime verification for a supplied ${channel} release`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination, releasePath }) => {
      const release = { platform: "linux-x64-deb", desktopVersion: "5.5.6.38337834", productVersion: "5.5.6",
        runtimeVersion: "2.137.1", sha256, channel,
        url: "https://download.codebuddy.cn/workbuddy/saas/linux-x64-deb/WorkBuddy-linux-x64-deb-5.5.6.38337834-5f969292.deb" };
      await writeFile(releasePath, JSON.stringify(release));
      const result = await run([destination, "x64", releasePath]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { desktopVersion: release.desktopVersion,
        runtimeVersion: release.runtimeVersion, arch: "x64", sha256, command: `extracted/${cliRelative}/bin/codebuddy` });
      assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
    });
  });
}

for (const invalid of ["missing", "empty path", "malformed", "platform", "runtime", "url", "baseline override"]) {
  test(`WorkBuddy Linux latest acquisition rejects ${invalid} release metadata before downloading`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination, releasePath }) => {
      const release = { ...latestRelease };
      if (invalid === "platform") release.platform = "darwin-arm64";
      if (invalid === "runtime") release.runtimeVersion = "2.137.1";
      if (invalid === "url") release.url = "https://example.com/WorkBuddy.deb";
      if (invalid === "baseline override") release.channel = "baseline";
      await writeFile(releasePath, invalid === "malformed" ? "{" : JSON.stringify(release));
      if (invalid === "missing") await rm(releasePath);
      const result = await run([destination, "x64", invalid === "empty path" ? "" : releasePath]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "WORKBUDDY_BUNDLE_RELEASE_INVALID\n");
      assert.deepEqual(await calls(), []);
      assert.deepEqual(await readdir(destination), []);
    });
  });
}

for (const [name, options, expected, expectedCalls] of [
  ["baseline digest and package version", {}, "PACKAGE_METADATA_INVALID", ["curl", "sha256sum", "field:Package", "field:Version"]],
  ["baseline package version", { hash: latestRelease.sha256 }, "PACKAGE_METADATA_INVALID", ["curl", "sha256sum", "field:Package", "field:Version"]],
]) {
  test(`WorkBuddy Linux latest acquisition rejects the ${name} for a different release`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination, releasePath }) => {
      const result = await run([destination, "x64", releasePath]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, (options.hash ? "" : hashWarning(sha256, latestRelease.sha256)) + `WORKBUDDY_BUNDLE_${expected}\n`);
      assert.deepEqual(await calls(), expectedCalls);
      assert.deepEqual(await readdir(destination), []);
    }, options);
  });
}

for (const version of ["latest", "2.160.1-beta.1", "02.160.1", "2.160", "2.160.1\n", null]) {
  test(`WorkBuddy Linux latest acquisition rejects invalid discovered runtime ${JSON.stringify(version)}`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination, releasePath, metadata, packageRoot }) => {
      metadata.publishConfig.customPackage.version = version;
      await writeFile(join(packageRoot, cliRelative, "package.json"), JSON.stringify(metadata));
      const result = await run([destination, "x64", releasePath]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "WORKBUDDY_BUNDLE_RUNTIME_METADATA_INVALID\n");
      assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
    }, { hash: latestRelease.sha256, packageVersion: latestRelease.productVersion });
  });
}

for (const [name, options, expected, expectedCalls] of [
  ["network failure", { curlExit: "22" }, "DOWNLOAD_FAILED", ["curl"]],
  ["checksum tool failure", { hashExit: "1" }, "HASH_FAILED", ["curl", "sha256sum"]],
  ["invalid checksum output", { hash: "invalid-digest" }, "HASH_FAILED", ["curl", "sha256sum"]],
  ["package name mismatch", { packageName: "codebuddy" }, "PACKAGE_METADATA_INVALID", ["curl", "sha256sum", "field:Package"]],
  ["package version mismatch", { packageVersion: "5.6.2" }, "PACKAGE_METADATA_INVALID", ["curl", "sha256sum", "field:Package", "field:Version"]],
  ["package architecture mismatch", { packageArch: "arm64" }, "PACKAGE_METADATA_INVALID", ["curl", "sha256sum", ...fields.map((field) => `field:${field}`)]],
  ["package metadata tool failure", { fieldExit: "1" }, "PACKAGE_METADATA_INVALID", ["curl", "sha256sum", "field:Package"]],
]) {
  test(`WorkBuddy Linux acquisition stops before extraction after ${name}`, posixOnly, async () => {
    await fixture(async ({ run, calls, destination }) => {
      const result = await run([destination]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      const diagnostic = expected === "DOWNLOAD_FAILED" ? diagnosticLine({ curlExit: Number(options.curlExit) }) : "";
      assert.equal(result.stderr, `WORKBUDDY_BUNDLE_${expected}\n${diagnostic}`);
      assert.deepEqual(await calls(), expectedCalls);
      assert.deepEqual(await readdir(destination), []);
    }, options);
  });
}

test("WorkBuddy Linux acquisition rejects partial responses even when curl succeeds", posixOnly, async () => {
  await fixture(async ({ run, calls, destination, diagnosticDir }) => {
    const result = await run([destination]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "WORKBUDDY_BUNDLE_RESPONSE_INVALID\n" + diagnosticLine({
      httpStatus: 206, contentRange: "bytes 0-14/429302312",
    }));
    assert.deepEqual(await calls(), ["curl"]);
    assert.deepEqual(await readdir(destination), []);
    assert.deepEqual(await readdir(diagnosticDir), ["download.json"]);
    assert.equal(JSON.parse(await readFile(join(diagnosticDir, "download.json"), "utf8")).packageRetained, false);
  }, { capture: true, hash: "0".repeat(64), httpStatus: "206", contentRange: "bytes 0-14/429302312",
    curlError: "private-credential-canary https://example.invalid/?signed=private-url-canary" });
});

test("WorkBuddy Linux acquisition rejects non-200, ranged, and inconsistent response lengths", posixOnly, async () => {
  for (const options of [{ httpStatus: "204" }, { contentRange: "bytes 0-14/15" },
    { contentLength: "16" }, { contentLength: "private-header-canary" }]) {
    await fixture(async ({ run, calls, destination }) => {
      const result = await run([destination]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^WORKBUDDY_BUNDLE_RESPONSE_INVALID\nWORKBUDDY_BUNDLE_DIAGNOSTIC /);
      assert.doesNotMatch(result.stderr, /private-header-canary/);
      assert.deepEqual(await calls(), ["curl"]);
      assert.deepEqual(await readdir(destination), []);
    }, options);
  }
});

test("WorkBuddy Linux hash drift warns without opt-in and reports the actual SHA", posixOnly, async () => {
  const hash = "03d756b259d7086c22098fa077589a032d60948d1de7313473360eefe11e240f";
  await fixture(async ({ run, calls, destination, diagnosticDir }) => {
    const result = await run([destination]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "::warning::WORKBUDDY_BUNDLE_HASH_MISMATCH_WARNING: Linux CI will continue only after package and runtime validation.\n"
      + diagnosticLine({ actualSha256: hash, contentLength: null }));
    assert.equal(JSON.parse(result.stdout).sha256, hash);
    assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
    await assert.rejects(readdir(diagnosticDir), { code: "ENOENT" });
  }, { hash, contentLength: "" });
});

test("WorkBuddy Linux download failure omits malformed and oversized response metadata", posixOnly, async () => {
  for (const contentRange of ["https://example.invalid/?signed=private-url-canary", "9".repeat(300)]) {
    await fixture(async ({ run, calls, destination }) => {
      const result = await run([destination]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "WORKBUDDY_BUNDLE_DOWNLOAD_FAILED\n" + diagnosticLine({
        curlExit: 22, httpStatus: contentRange.length > 256 ? null : 403, contentLength: null,
      }));
      assert.deepEqual(await calls(), ["curl"]);
      assert.deepEqual(await readdir(destination), []);
    }, { curlExit: "22", httpStatus: "403", contentLength: "private-header-canary", contentRange,
      curlError: "Authorization: Bearer private-credential-canary" });
  }
});

test("WorkBuddy Linux opt-in retains completed downloads and records hash drift", posixOnly, async () => {
  const effectiveUrl = "https://download.codebuddy.cn/private-path-canary?signature=private-query-canary";
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  for (const hash of [sha256, "0".repeat(64)]) {
    await fixture(async ({ run, calls, destination, diagnosticDir }) => {
      const result = await run([destination]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, hash === sha256 ? "" : hashWarning(hash));
      assert.equal(JSON.parse(result.stdout).sha256, hash);
      assert.deepEqual(await readdir(diagnosticDir), ["WorkBuddy.deb", "download.json"]);
      assert.equal(await readFile(join(diagnosticDir, "WorkBuddy.deb"), "utf8"), "Synthetic deb.\n");
      const metadata = await readFile(join(diagnosticDir, "download.json"), "utf8");
      assert.deepEqual(JSON.parse(metadata), {
        expectedSha256: sha256, actualSha256: hash, bytes: 15, curlExit: 0,
        httpStatus: 200, contentLength: 15, contentRange: null, packageRetained: true,
        requestedUrl: "https://download.codebuddy.cn/workbuddy/saas/linux-x64-deb/WorkBuddy-linux-x64-deb-5.5.6.38337834-5f969292.deb",
        effectiveOrigin: "https://download.codebuddy.cn", pathMatchedRequested: false,
        pathSha256: digest("/private-path-canary"), effectiveUrlSha256: digest(effectiveUrl), redirectCount: 1,
        etag: '"0123456789abcdef0123456789abcdef-2"', lastModified: "Wed, 01 Jul 2026 12:00:00 GMT", contentEncoding: "gzip",
      });
      assert.doesNotMatch(metadata + result.stdout + result.stderr, /private-(?:path|query|credential)-canary/);
      assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
      assert.deepEqual(await readdir(destination), ["WorkBuddy.deb", "extracted"]);
    }, { capture: true, hash, effectiveUrl, redirectCount: "1", etag: '"0123456789abcdef0123456789abcdef-2"',
      lastModified: "Wed, 01 Jul 2026 12:00:00 GMT", contentEncoding: "gzip", curlError: "private-credential-canary" });
  }
});

test("WorkBuddy Linux opt-in keeps only sanitized metadata after an incomplete download", posixOnly, async () => {
  await fixture(async ({ run, destination, diagnosticDir }) => {
    const result = await run([destination]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "WORKBUDDY_BUNDLE_DOWNLOAD_FAILED\n" + diagnosticLine({ curlExit: 22 }));
    assert.deepEqual(await readdir(diagnosticDir), ["download.json"]);
    const text = await readFile(join(diagnosticDir, "download.json"), "utf8");
    const metadata = JSON.parse(text);
    assert.equal(metadata.packageRetained, false);
    for (const field of ["effectiveOrigin", "pathMatchedRequested", "pathSha256", "effectiveUrlSha256", "redirectCount", "etag", "lastModified", "contentEncoding"]) {
      assert.equal(metadata[field], null, field);
    }
    assert.doesNotMatch(text + result.stdout + result.stderr, /private-canary/);
    assert.deepEqual(await readdir(destination), []);
  }, { capture: true, curlExit: "22", effectiveUrl: "https://private-canary@example.invalid/private-canary",
    redirectCount: "private-canary", etag: "private-canary", lastModified: "private-canary", contentEncoding: "private-canary" });
});

test("WorkBuddy Linux diagnostic capture failure preserves the original acquisition result", posixOnly, async () => {
  for (const curlExit of ["0", "22"]) {
    await fixture(async ({ run, destination, diagnosticDir }) => {
      await mkdir(diagnosticDir);
      await writeFile(join(diagnosticDir, "sentinel"), "Existing diagnostic.\n");
      const result = await run([destination]);
      assert.equal(result.code, curlExit === "0" ? 0 : 1);
      assert.equal(result.stderr, (curlExit === "0" ? hashWarning("0".repeat(64))
        : "WORKBUDDY_BUNDLE_DOWNLOAD_FAILED\n" + diagnosticLine({ curlExit: 22 }))
        + "WORKBUDDY_BUNDLE_DIAGNOSTIC_CAPTURE_FAILED\n");
      assert.deepEqual(await readdir(diagnosticDir), ["sentinel"]);
      assert.equal(await readFile(join(diagnosticDir, "sentinel"), "utf8"), "Existing diagnostic.\n");
    }, { capture: true, hash: "0".repeat(64), curlExit });
  }
});

test("WorkBuddy Linux acquisition reports extraction failure without publishing a command", posixOnly, async () => {
  await fixture(async ({ run, calls, destination }) => {
    const result = await run([destination]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "WORKBUDDY_BUNDLE_EXTRACT_FAILED\n");
    assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
    assert.deepEqual(await readdir(destination), ["WorkBuddy.deb"]);
  }, { extractExit: "1" });
});

for (const mutation of ["runtime version", "runtime package", "runtime bin", "missing command", "non-executable command", "command symlink", "metadata symlink", "invalid JSON", "wrong layout"]) {
  test(`WorkBuddy Linux acquisition rejects ${mutation} without running the extracted client`, posixOnly, async () => {
    await fixture(async ({ run, calls, root, packageRoot, destination, metadata }) => {
      const cli = join(packageRoot, cliRelative);
      const command = join(cli, "bin/codebuddy"), packageJson = join(cli, "package.json");
      if (mutation === "runtime version") metadata.publishConfig.customPackage.version = "2.147.0";
      if (mutation === "runtime package") metadata.publishConfig.customPackage.name = "other-cli";
      if (mutation === "runtime bin") metadata.bin.codebuddy = "other-command";
      await writeFile(packageJson, JSON.stringify(metadata));
      if (mutation === "missing command") await rm(command);
      if (mutation === "non-executable command") await chmod(command, 0o644);
      if (mutation === "command symlink" || mutation === "metadata symlink") {
        const target = mutation === "command symlink" ? command : packageJson;
        const external = join(root, "external");
        await writeFile(external, await readFile(target));
        await chmod(external, 0o755);
        await rm(target);
        await symlink(external, target);
      }
      if (mutation === "invalid JSON") await writeFile(packageJson, "{");
      if (mutation === "wrong layout") {
        await rm(join(packageRoot, "opt"), { recursive: true });
        await mkdir(join(packageRoot, "node_modules/@tencent-ai/codebuddy-code"), { recursive: true });
      }
      const result = await run([destination]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, hashWarning("0".repeat(64)) + "WORKBUDDY_BUNDLE_RUNTIME_METADATA_INVALID\n");
      assert.deepEqual(await calls(), ["curl", "sha256sum", ...fields.map((field) => `field:${field}`), "extract"]);
    }, { hash: "0".repeat(64) });
  });
}

async function fixture(callback, { os = "Linux", machine = "x86_64", hash = sha256, curlExit = "0", hashExit = "0",
  httpStatus = "200", contentLength = "15", contentRange = "", curlError = "",
  capture = false, effectiveUrl = "", redirectCount = "0", etag = "", lastModified = "", contentEncoding = "",
  packageName = "workbuddy", packageVersion = "5.5.6", packageArch = "amd64", fieldExit = "0", extractExit = "0" } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbuddy-linux-bundle-check-")));
  const bin = join(root, "bin"), destination = join(root, "download"), packageRoot = join(root, "package");
  const callLog = join(root, "calls"), curlLog = join(root, "curl-args"), dpkgLog = join(root, "dpkg-args");
  const releasePath = join(root, "release.json");
  const diagnosticDir = join(root, "diagnostic");
  try {
    await Promise.all([bin, destination, join(root, "home"), join(root, "tmp"), join(packageRoot, cliRelative, "bin")]
      .map((path) => mkdir(path, { recursive: true })));
    await writeFile(releasePath, JSON.stringify(latestRelease));
    const metadata = { bin: { codebuddy: "./bin/codebuddy" },
      publishConfig: { customPackage: { name: "@tencent-ai/codebuddy-code", version: "2.137.1" } } };
    await writeFile(join(packageRoot, cliRelative, "package.json"), JSON.stringify(metadata));
    const command = join(packageRoot, cliRelative, "bin/codebuddy");
    await writeFile(command, '#!/bin/sh\nprintf "client-executed\\n" >> "$FAKE_CALLS"\nexit 99\n');
    await chmod(command, 0o755);
    const stubs = {
      uname: 'case "$1" in -s) printf "%s\\n" "$FAKE_OS" ;; -m) printf "%s\\n" "$FAKE_MACHINE" ;; *) exit 1 ;; esac',
      curl: `printf 'curl\\n' >> "$FAKE_CALLS"
printf '%s\\n' "$@" > "$FAKE_CURL_ARGS"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output="$2"; break; fi
  shift
done
printf 'Synthetic deb.\\n' > "$output"
printf '%s\\n' "$FAKE_HTTP_STATUS" "$FAKE_CONTENT_LENGTH" "$FAKE_CONTENT_RANGE" "$FAKE_EFFECTIVE_URL" "$FAKE_REDIRECT_COUNT" "$FAKE_ETAG" "$FAKE_LAST_MODIFIED" "$FAKE_CONTENT_ENCODING"
printf '%s\\n' "$FAKE_CURL_ERROR" >&2
exit "$FAKE_CURL_EXIT"`,
      sha256sum: `printf 'sha256sum\\n' >> "$FAKE_CALLS"
[[ $# -eq 1 && "$1" == */WorkBuddy.deb.partial ]] || exit 2
printf '%s  %s\\n' "$FAKE_HASH" "$1"
exit "$FAKE_HASH_EXIT"`,
      "dpkg-deb": `printf '%s\\n' "$@" >> "$FAKE_DPKG_ARGS"
[[ $# -eq 3 ]] || exit 2
if [[ "$1" == --field && "$2" == */WorkBuddy.deb.partial ]]; then
  printf 'field:%s\\n' "$3" >> "$FAKE_CALLS"
  case "$3" in
    Package) printf '%s\\n' "$FAKE_PACKAGE_NAME" ;;
    Version) printf '%s\\n' "$FAKE_PACKAGE_VERSION" ;;
    Architecture) printf '%s\\n' "$FAKE_PACKAGE_ARCH" ;;
    *) exit 2 ;;
  esac
  exit "$FAKE_FIELD_EXIT"
elif [[ "$1" == -x && "$2" == */WorkBuddy.deb && "$3" == */extracted ]]; then
  printf 'extract\\n' >> "$FAKE_CALLS"
  [[ "$FAKE_EXTRACT_EXIT" == 0 ]] || exit "$FAKE_EXTRACT_EXIT"
  mkdir "$3"
  cp -R "$FAKE_PACKAGE_ROOT/." "$3"
else
  exit 2
fi`,
    };
    for (const [name, source] of Object.entries(stubs)) {
      const path = join(bin, name);
      await writeFile(path, `#!/bin/bash\nset -eu\n${source}\n`);
      await chmod(path, 0o755);
    }
    const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
      MEMORAX_CODE_HOME: join(root, "state"), FAKE_OS: os, FAKE_MACHINE: machine, FAKE_HASH: hash,
      FAKE_CURL_EXIT: curlExit, FAKE_HASH_EXIT: hashExit, FAKE_PACKAGE_NAME: packageName,
      FAKE_HTTP_STATUS: httpStatus, FAKE_CONTENT_LENGTH: contentLength, FAKE_CONTENT_RANGE: contentRange, FAKE_CURL_ERROR: curlError,
      FAKE_EFFECTIVE_URL: effectiveUrl, FAKE_REDIRECT_COUNT: redirectCount, FAKE_ETAG: etag,
      FAKE_LAST_MODIFIED: lastModified, FAKE_CONTENT_ENCODING: contentEncoding,
      ...(capture ? { WORKBUDDY_DOWNLOAD_DIAGNOSTIC_DIR: diagnosticDir } : {}),
      FAKE_PACKAGE_VERSION: packageVersion, FAKE_PACKAGE_ARCH: packageArch, FAKE_FIELD_EXIT: fieldExit,
      FAKE_EXTRACT_EXIT: extractExit, FAKE_PACKAGE_ROOT: packageRoot, FAKE_CALLS: callLog,
      FAKE_CURL_ARGS: curlLog, FAKE_DPKG_ARGS: dpkgLog };
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
    await callback({ root, destination, packageRoot, releasePath, diagnosticDir, metadata, run, calls: () => lines(callLog),
      curlArgs: () => lines(curlLog), dpkgArgs: () => lines(dpkgLog) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { verifyCursorAptSignature, verifyLinuxAptReleases } from "./cursor-app-apt.mjs";

const fingerprint = "380FF4BCDC34A4BD92A3565342A1772E62E492D6";
const validStatus = `[GNUPG:] VALIDSIG ${fingerprint} 2026-10-03 1791015644 0 4 0 1 8 01 ${fingerprint}\n`;
// Public signed metadata from https://downloads.cursor.com/aptrepo/dists/stable/InRelease.
const officialInRelease = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

Codename: stable
Date: Sat, 03 Oct 2026 08:20:44 UTC
Architectures: amd64 arm64 all
Components: main
Suite:
MD5Sum:
 ab1d828678b0bd34f564abf565b814c3              882 main/binary-all/Packages
 dd931db6c86ce0d5eca36ba3f50fb8fd              570 main/binary-all/Packages.gz
 75080ea9c334375c1a883842acca26a4             5210 main/binary-amd64/Packages
 819221ba1ba45947adb999d9d35b90a3             1458 main/binary-amd64/Packages.gz
 9930d94cfbdf2437f6df455045e76969             5156 main/binary-arm64/Packages
 def3a014917ba74d23e785dad04b6888             1461 main/binary-arm64/Packages.gz
SHA1:
 c21e750c9c0b3a428c9a10fba4c22977e4d04fb4              882 main/binary-all/Packages
 d1e41529972f37147adbad6ec7e56d318550ea6e              570 main/binary-all/Packages.gz
 75cdd7f7fced196394694f511cd14a87e05f8cef             5210 main/binary-amd64/Packages
 934617476b6135e0a261f4433b40f1814483f8e0             1458 main/binary-amd64/Packages.gz
 a7aaf78b00d6b232e65aa7b2091d4f3d259eddb5             5156 main/binary-arm64/Packages
 4069b53f6540ddc9f3ad938ebcd7d781f0c87fa5             1461 main/binary-arm64/Packages.gz
SHA256:
 aee65949223283e9f9a31bd7d66b135bdac69f3781e2ee5fc5fb0f3269c76998              882 main/binary-all/Packages
 9a1544e73017031984804c32eaaec2e6ad63cfae84917738dc1c6fda9aefaea1              570 main/binary-all/Packages.gz
 97e28bc4fc90ad1a3821ebf3f5370eba4a2ca192ca32d67604094f8bcf0488d5             5210 main/binary-amd64/Packages
 f276a4c79559ab7e6c59d7e05d2db6629b4549a9c997b2020ecdc85e3a6b9694             1458 main/binary-amd64/Packages.gz
 5a48f2d45cfa81261c50e920814ad6f49e9a3a98918b0859192b549a10fde877             5156 main/binary-arm64/Packages
 190da6d6b2b9daed1d8f4fe33f07e1fdc2a61bf54de4371886286d0b9e8abfc5             1461 main/binary-arm64/Packages.gz
-----BEGIN PGP SIGNATURE-----

iQIzBAEBCAAdFiEEOA/0vNw0pL2So1ZTQqF3LmLkktYFAmrAutwACgkQQqF3LmLk
ktZbthAAtEshHet0ZgQ9fOaWfbzykmDUj+X895SAFjODhwzI4TiyvS4XDFZA/VMD
I48cPh++Kd+b6sR9wHRryAtIYjto4gwBNwA9Vh2VtnTmgDp32bNgP5fYzq5pKmLQ
BXRde7ZJB5IzSSF/MmCpNVwBgKtRxWmAdOHjM15GM1k6U58g3RFD1UVf+jLxZaH6
NONUoB/ffEnHvTStQftcW9zql700/dXfuok8OfRJugwglImD/n4aKEBc+df35JFs
WRXVvUDt0ufQ5d0C43+xWUlyC3cbceuPUdWvRcx5OC8Oddxi5EcQc2/m0aMsqVcQ
a8/F5wRiAQwRahxbiuuXjPNU2lkqyduRR4XG2hn9VGLnve826Iks8z89jsL+YZEQ
63SoxEOfSlKzaCzV7YIw77gArClLeNQDpdqrsaQ7mreZWONcowi+LfA2PpxbaNFE
sUsy3kBEQcdFvp4LhuDK9Unyv1X44kJt5kqUMtxPsyOiSwzhJYKM9TR7JRLMX11z
Uzt2zHumL2wws+DO9fodXOlJiONGY99xqdGyqr0p7G1HfYEv0uypARvlndZTCIrB
dR9lqTc32Bi6ed9kPOFZ6qg9BTQYIKJZESRzhWjRjNsk51jXFzsgi9so/jHpbbBc
nrj73OZxaEg8jueFQDuGESVY334Smsrc99yftDKFE0U2q8grntQ=
=v194
-----END PGP SIGNATURE-----
`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = "3.23.12", commitSha = "2".repeat(40);
function descriptor(platform) {
  const arch = platform === "linux-x64" ? "amd64" : "arm64", downloadArch = arch === "amd64" ? "x64" : "arm64";
  return { platform, version, commitSha, channel: "latest", sha256: null, hashSource: "not-provided",
    url: `https://downloads.cursor.com/production/${commitSha}/linux/${downloadArch}/deb/${arch}/deb/cursor_${version}_${arch}.deb` };
}
const descriptors = Object.fromEntries(["linux-x64", "linux-arm64"].map((platform) => [platform, descriptor(platform)]));
function packages(arch) {
  return Buffer.from(`Package: cursor-nightly\nVersion: 99.0.0\nArchitecture: ${arch}\n\nPackage: cursor\nVersion: ${version}-1790831722\nArchitecture: ${arch}\nFilename: pool/stable/c/cu/cursor_${version}_${arch}.deb\nSize: 200\nSHA256: ${"a".repeat(64)}\nDescription: Synthetic fixture\n continuation\n`);
}
function releaseFor(bodies) {
  return `Codename: stable\nArchitectures: amd64 arm64 all\nComponents: main\nSHA256:\n${Object.entries(bodies).map(([arch, bytes]) => ` ${sha(bytes)} ${bytes.length} main/binary-${arch}/Packages`).join("\n")}\n`;
}
function fixture(overrides = {}) {
  const calls = [], bodies = { amd64: packages("amd64"), arm64: packages("arm64"), ...overrides };
  const signed = Buffer.from("synthetic signed input");
  return { calls, bodies, options: {
    fetchBytes: async (url) => {
      calls.push(url);
      if (url.endsWith("/InRelease")) return signed;
      const arch = url.match(/\/binary-(amd64|arm64)\/Packages$/)?.[1];
      assert.ok(arch);
      return bodies[arch];
    },
    verifySignature: async (bytes) => { assert.deepEqual(bytes, signed); return releaseFor(bodies); },
  } };
}

test("Cursor apt verifies one signed index before using both exact architecture package entries", async () => {
  const { calls, options } = fixture();
  const actual = await verifyLinuxAptReleases(descriptors, options);
  assert.deepEqual(calls, ["https://downloads.cursor.com/aptrepo/dists/stable/InRelease",
    "https://downloads.cursor.com/aptrepo/dists/stable/main/binary-amd64/Packages",
    "https://downloads.cursor.com/aptrepo/dists/stable/main/binary-arm64/Packages"]);
  for (const platform of Object.keys(descriptors)) {
    assert.deepEqual(actual[platform], { ...descriptors[platform], hashSource: "official-apt-sha256",
      sha256: "a".repeat(64), debVersion: `${version}-1790831722`, size: 200 });
  }
});

test("Cursor apt stops before Packages on signature failures and sanitizes the error", async () => {
  const { calls, options } = fixture();
  await assert.rejects(verifyLinuxAptReleases(descriptors, { ...options,
    verifySignature: async () => { throw new Error("private diagnostic path"); } }),
  { code: "CURSOR_RELEASE_APT_SIGNATURE_FAILED", message: "CURSOR_RELEASE_APT_SIGNATURE_FAILED" });
  assert.equal(calls.length, 1);
});

test("Cursor apt rejects wrong signed repository fields, missing or duplicate checksum entries", async () => {
  for (const change of [(text) => text.replace("Codename: stable", "Codename: nightly"),
    (text) => text.replace("amd64 arm64 all", "amd64"), (text) => text.replace("Components: main", "Components: contrib"),
    (text) => text.replace("SHA256:", "SHA1:"), (text) => text.replace("main/binary-amd64/Packages", "../Packages"),
    (text) => text + text.split("\n").find((line) => line.endsWith("binary-amd64/Packages")) + "\n",
    (text) => text + "Codename: stable\n", (text) => text.replace("SHA256:", "SHA256: bad")]) {
    const { options, bodies } = fixture();
    await assert.rejects(verifyLinuxAptReleases(descriptors, { ...options,
      verifySignature: async () => change(releaseFor(bodies)) }), { code: "CURSOR_RELEASE_APT_INDEX_INVALID" });
  }
});

test("Cursor apt requires Packages bytes and size to match the signed index", async () => {
  for (const change of [(bytes) => Buffer.concat([bytes, Buffer.from("\n")]),
    (bytes) => Buffer.from(bytes.toString().replace("cursor-nightly", "Cursor-nightly"))]) {
    const { options } = fixture();
    await assert.rejects(verifyLinuxAptReleases(descriptors, { ...options,
      fetchBytes: async (url) => { const bytes = await options.fetchBytes(url); return url.endsWith("/Packages") ? change(bytes) : bytes; } }),
    { code: "CURSOR_RELEASE_APT_PACKAGES_INTEGRITY" });
  }
});

test("Cursor apt rejects wrong, duplicate or ambiguous package identity and invalid digests", async () => {
  for (const transform of [(text) => text.replace("Package: cursor\n", "Package: other\n"),
    (text) => text.replace(`${version}-1790831722`, "3.23.11-1790831722"),
    (text) => text.replaceAll("Architecture: amd64", "Architecture: arm64"),
    (text) => text.replace("pool/stable/c/cu/", "../"), (text) => text.replace("Size: 200", "Size: 0"),
    (text) => text.replace("Size: 200", "Size: 300000001"), (text) => text.replace("Size: 200", "Size: 2e2"),
    (text) => text.replace("SHA256: " + "a".repeat(64), "SHA256: invalid"),
    (text) => text + "sha256: " + "b".repeat(64) + "\n", (text) => text + "\n" + text,
    (text) => text.replace(`${version}-1790831722`, `${version}-1790831722-extra`)]) {
    const { options } = fixture({ amd64: Buffer.from(transform(packages("amd64").toString())) });
    await assert.rejects(verifyLinuxAptReleases(descriptors, options), { code: "CURSOR_RELEASE_APT_PACKAGE_INVALID" });
  }
  for (const change of [{ platform: "linux-arm64" }, { url: "https://example.com/cursor.deb" },
    { commitSha: "main" }, { version: "3.23.12\n" }, { channel: "baseline" }]) {
    await assert.rejects(verifyLinuxAptReleases({ ...descriptors, "linux-x64": { ...descriptors["linux-x64"], ...change } }, fixture().options),
      { code: "CURSOR_RELEASE_APT_DESCRIPTOR_INVALID" });
  }
});

test("Cursor apt subprocesses use only the pinned key and an isolated HOME, then remove it", async () => {
  const calls = [];
  const text = releaseFor({ amd64: packages("amd64"), arm64: packages("arm64") });
  const verified = await verifyCursorAptSignature(Buffer.from("signed fixture"), { run: async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(options.env.HOME, options.env.GNUPGHOME);
    assert.equal(args[args.indexOf("--homedir") + 1], options.env.HOME);
    assert.equal(options.env.LC_ALL, "C");
    assert.ok(!Object.hasOwn(options.env, "GITHUB_TOKEN"));
    assert.ok(options.timeout > 0 && options.maxBuffer <= 64 * 1024);
    if (file === "gpg") {
      assert.ok(args.includes("--no-options") && args.includes("--batch") && args.includes("--dearmor"));
      const key = await readFile(args.at(-1));
      assert.equal(sha(key), "9d2adcc95efdf65e6e76f964968734551ab70181634781f9d5952b271895ec03");
      return { stdout: "", stderr: "" };
    }
    assert.equal(file, "gpgv");
    assert.equal(args[args.indexOf("--keyring") + 1], join(options.env.HOME, "keyring.gpg"));
    await writeFile(args[args.indexOf("--output") + 1], text);
    return { stdout: validStatus, stderr: "ignored private diagnostics" };
  } });
  assert.equal(verified, text);
  assert.equal(calls.length, 2);
  await assert.rejects(stat(calls[0].options.env.HOME), { code: "ENOENT" });
});

test("Cursor apt signature verifier rejects wrong signers, weak hashes, expired or multiple signatures", async () => {
  for (const status of ["", validStatus.replaceAll(fingerprint, "A".repeat(40)), validStatus.replace(" 1 8 01 ", " 1 2 01 "),
    validStatus + validStatus, validStatus + "[GNUPG:] EXPKEYSIG key expired\n", validStatus + "[GNUPG:] BADSIG bad\n"]) {
    let root;
    await assert.rejects(verifyCursorAptSignature(Buffer.from("signed fixture"), { run: async (file, args, options) => {
      root = options.env.HOME;
      if (file === "gpgv") await writeFile(args[args.indexOf("--output") + 1], "Codename: stable\n");
      return { stdout: file === "gpgv" ? status : "", stderr: "" };
    } }), { code: "CURSOR_RELEASE_APT_SIGNATURE_FAILED" });
    await assert.rejects(stat(root), { code: "ENOENT" });
  }
  await assert.rejects(verifyCursorAptSignature(Buffer.from("signed fixture"), {
    run: async () => { throw new Error("private credential-store path"); },
  }), { code: "CURSOR_RELEASE_APT_SIGNATURE_FAILED", message: "CURSOR_RELEASE_APT_SIGNATURE_FAILED" });
});

test("Cursor apt verifies the official signature with real GPG and rejects tampering", {
  skip: process.platform !== "linux" ? "GPG is required by the Linux release resolver job" : false,
}, async () => {
  const verified = await verifyCursorAptSignature(Buffer.from(officialInRelease));
  assert.match(verified, /^Codename: stable\n/m);
  assert.match(verified, /97e28bc4fc90ad1a3821ebf3f5370eba4a2ca192ca32d67604094f8bcf0488d5\s+5210 main\/binary-amd64\/Packages/);
  assert.match(verified, /5a48f2d45cfa81261c50e920814ad6f49e9a3a98918b0859192b549a10fde877\s+5156 main\/binary-arm64\/Packages/);
  for (const modified of [officialInRelease.replace("Codename: stable", "Codename: nightly"),
    officialInRelease.replace("ktZbthAAtEsh", "atZbthAAtEsh")]) {
    await assert.rejects(verifyCursorAptSignature(Buffer.from(modified)), {
      code: "CURSOR_RELEASE_APT_SIGNATURE_FAILED", message: "CURSOR_RELEASE_APT_SIGNATURE_FAILED",
    });
  }
});

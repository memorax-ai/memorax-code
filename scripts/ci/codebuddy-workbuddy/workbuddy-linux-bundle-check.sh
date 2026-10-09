#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
  echo 'Usage: scripts/ci/codebuddy-workbuddy/workbuddy-linux-bundle-check.sh EMPTY_DESTINATION_DIR [x64 [RELEASE_JSON]]'
  exit 0
fi

fail() {
  printf '%s\n' "$1" >&2
  case "$1" in
    WORKBUDDY_BUNDLE_DOWNLOAD_FAILED|WORKBUDDY_BUNDLE_HASH_MISMATCH) download_diagnostic ;;
  esac
  exit 1
}

download_diagnostic() {
  node --input-type=module - "$sha256" "${actual%% *}" "$partial" "$transfer" "$curl_exit" <<'NODE' >&2 2>/dev/null || true
import { lstatSync, readFileSync } from 'node:fs';
const [expected, actual, partial, transfer, exit] = process.argv.slice(2);
const hash = (value) => /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null;
const integer = (value) => /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
let bytes = null, fields = [];
try {
  const info = lstatSync(partial);
  if (info.isFile() && Number.isSafeInteger(info.size)) bytes = info.size;
} catch {}
try {
  const info = lstatSync(transfer);
  if (info.isFile() && info.size <= 256) fields = readFileSync(transfer, 'utf8').split('\n');
} catch {}
const [status, length, range] = fields.length === 4 ? fields : [];
console.log('WORKBUDDY_BUNDLE_DIAGNOSTIC ' + JSON.stringify({
  expectedSha256: hash(expected), actualSha256: hash(actual), bytes, curlExit: integer(exit),
  httpStatus: /^[1-5]\d{2}$/.test(status) ? Number(status) : null,
  contentLength: integer(length),
  contentRange: /^bytes (?:\d{1,16}-\d{1,16}|\*)\/(?:\d{1,16}|\*)$/.test(range) ? range : null,
}));
NODE
}

[[ $# -ge 1 && $# -le 3 ]] || fail WORKBUDDY_BUNDLE_ARGUMENTS_INVALID
[[ "$(uname -s)" == Linux ]] || fail WORKBUDDY_BUNDLE_LINUX_REQUIRED
case "${2:-$(uname -m)}" in
  x64|x86_64) arch=x64 ;;
  *) fail WORKBUDDY_BUNDLE_ARCH_UNSUPPORTED ;;
esac
destination="$1"
[[ -d "$destination" && ! -L "$destination" ]] || fail WORKBUDDY_BUNDLE_DESTINATION_INVALID
shopt -s nullglob dotglob
entries=("$destination"/*)
[[ ${#entries[@]} -eq 0 ]] || fail WORKBUDDY_BUNDLE_DESTINATION_NOT_EMPTY
destination="$(cd -- "$destination" && pwd -P)"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
for tool in curl sha256sum dpkg-deb node; do
  command -v "$tool" >/dev/null || fail WORKBUDDY_BUNDLE_DEPENDENCY_MISSING
done
selection=(select linux-x64-deb)
if [[ $# -eq 3 ]]; then
  [[ -n "$3" ]] || fail WORKBUDDY_BUNDLE_RELEASE_INVALID
  selection+=("$3")
fi
if ! release="$(node "$script_dir/workbuddy-release-matrix.mjs" "${selection[@]}" 2>/dev/null)"; then
  fail WORKBUDDY_BUNDLE_RELEASE_INVALID
fi
IFS=$'\t' read -r desktop_version product_version runtime_version sha256 url <<< "$release"
partial="$destination/WorkBuddy.deb.partial"
transfer="$destination/WorkBuddy.download"
trap 'rm -f -- "$partial" "$transfer" 2>/dev/null' EXIT
actual=""
curl_exit=0

curl --disable --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 \
  --retry 2 --retry-max-time 900 \
  --write-out '%{http_code}\n%header{content-length}\n%header{content-range}\n' \
  --output "$partial" "$url" >"$transfer" 2>/dev/null || curl_exit=$?
[[ "$curl_exit" == 0 ]] || fail WORKBUDDY_BUNDLE_DOWNLOAD_FAILED
[[ -f "$partial" && ! -L "$partial" ]] || fail WORKBUDDY_BUNDLE_DOWNLOAD_MISSING
if ! actual="$(sha256sum "$partial" 2>/dev/null)"; then
  fail WORKBUDDY_BUNDLE_HASH_FAILED
fi
[[ "${actual%% *}" == "$sha256" ]] || fail WORKBUDDY_BUNDLE_HASH_MISMATCH
for field in Package Version Architecture; do
  case "$field" in
    Package) expected=workbuddy ;;
    Version) expected="$product_version" ;;
    Architecture) expected=amd64 ;;
  esac
  if ! value="$(dpkg-deb --field "$partial" "$field" 2>/dev/null)"; then
    fail WORKBUDDY_BUNDLE_PACKAGE_METADATA_INVALID
  fi
  [[ "$value" == "$expected" ]] || fail WORKBUDDY_BUNDLE_PACKAGE_METADATA_INVALID
done
if ! mv -- "$partial" "$destination/WorkBuddy.deb" 2>/dev/null; then
  fail WORKBUDDY_BUNDLE_DESTINATION_WRITE_FAILED
fi
# Extract the official package without installing it or running maintainer scripts.
if ! dpkg-deb -x "$destination/WorkBuddy.deb" "$destination/extracted" >/dev/null 2>&1; then
  fail WORKBUDDY_BUNDLE_EXTRACT_FAILED
fi
command_relative=extracted/opt/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy
if ! actual_runtime="$(node --input-type=module - "$destination" "$runtime_version" <<'NODE' 2>/dev/null
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
const cli = join(process.argv[2], 'extracted/opt/WorkBuddy/resources/app.asar.unpacked/cli');
for (const name of ['bin/codebuddy', 'package.json']) {
  const path = join(cli, name);
  assert.equal(realpathSync(path), path);
  assert.ok(statSync(path).isFile());
}
accessSync(join(cli, 'bin/codebuddy'), constants.X_OK);
const metadata = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'));
assert.equal(metadata.publishConfig?.customPackage?.name, '@tencent-ai/codebuddy-code');
const version = metadata.publishConfig?.customPackage?.version;
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.ok(!/[\r\n]/.test(version));
if (process.argv[3] !== 'discover') assert.equal(version, process.argv[3]);
assert.equal(metadata.bin?.codebuddy, './bin/codebuddy');
process.stdout.write(version);
NODE
)"; then
  fail WORKBUDDY_BUNDLE_RUNTIME_METADATA_INVALID
fi
if ! node "$script_dir/workbuddy-bundled-command-check.mjs" "$destination/$command_relative" >/dev/null 2>&1; then
  fail WORKBUDDY_BUNDLE_COMMAND_INVALID
fi
printf '{"desktopVersion":"%s","runtimeVersion":"%s","arch":"%s","sha256":"%s","command":"%s"}\n' \
  "$desktop_version" "$actual_runtime" "$arch" "$sha256" "$command_relative"

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
  echo 'Usage: scripts/workbuddy-macos-bundle-check.sh EMPTY_DESTINATION_DIR [arm64|x64 [RELEASE_JSON]]'
  exit 0
fi

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ $# -ge 1 && $# -le 3 ]] || fail WORKBUDDY_BUNDLE_ARGUMENTS_INVALID
[[ "$(uname -s)" == Darwin ]] || fail WORKBUDDY_BUNDLE_MACOS_REQUIRED
arch="${2:-$(uname -m)}"
case "$arch" in
  arm64) ;;
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
command -v node >/dev/null || fail WORKBUDDY_BUNDLE_DEPENDENCY_MISSING
selection=(select "darwin-$arch")
if [[ $# -eq 3 ]]; then
  [[ -n "$3" ]] || fail WORKBUDDY_BUNDLE_RELEASE_INVALID
  selection+=("$3")
fi
if ! release="$(node "$script_dir/workbuddy-release-matrix.mjs" "${selection[@]}" 2>/dev/null)"; then
  fail WORKBUDDY_BUNDLE_RELEASE_INVALID
fi
IFS=$'\t' read -r desktop_version product_version runtime_version sha256 url <<< "$release"
partial="$destination/WorkBuddy.dmg.partial"
trap 'rm -f -- "$partial" 2>/dev/null' EXIT

if ! curl --disable --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 \
  --retry 2 --retry-max-time 900 --output "$partial" "$url" >/dev/null 2>&1; then
  fail WORKBUDDY_BUNDLE_DOWNLOAD_FAILED
fi
[[ -f "$partial" && ! -L "$partial" ]] || fail WORKBUDDY_BUNDLE_DOWNLOAD_MISSING
if ! actual="$(shasum -a 256 "$partial" 2>/dev/null)"; then
  fail WORKBUDDY_BUNDLE_HASH_FAILED
fi
[[ "${actual%% *}" == "$sha256" ]] || fail WORKBUDDY_BUNDLE_HASH_MISMATCH
if ! mv -- "$partial" "$destination/WorkBuddy.dmg" 2>/dev/null; then
  fail WORKBUDDY_BUNDLE_DESTINATION_WRITE_FAILED
fi
runtime_json=null
if [[ "$runtime_version" != discover ]]; then runtime_json="\"$runtime_version\""; fi
printf '{"desktopVersion":"%s","runtimeVersion":%s,"arch":"%s","sha256":"%s","file":"WorkBuddy.dmg"}\n' \
  "$desktop_version" "$runtime_json" "$arch" "$sha256"

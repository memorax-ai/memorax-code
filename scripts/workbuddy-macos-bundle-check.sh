#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
  echo 'Usage: scripts/workbuddy-macos-bundle-check.sh EMPTY_DESTINATION_DIR [arm64|x64]'
  exit 0
fi

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ $# -ge 1 && $# -le 2 ]] || fail WORKBUDDY_BUNDLE_ARGUMENTS_INVALID
[[ "$(uname -s)" == Darwin ]] || fail WORKBUDDY_BUNDLE_MACOS_REQUIRED
arch="${2:-$(uname -m)}"
desktop_version=5.6.2.39298511
runtime_version=2.147.0
case "$arch" in
  arm64)
    sha256=251d3e56a940a6061752534e5466e7dab332d4ee06148824a569a739892e1c21
    ;;
  x64|x86_64)
    arch=x64
    sha256=0bee8b10407eebbfff3e1a177bfc790f6c95f6cd66bceb5676fd13a709b5715b
    ;;
  *) fail WORKBUDDY_BUNDLE_ARCH_UNSUPPORTED ;;
esac

destination="$1"
[[ -d "$destination" && ! -L "$destination" ]] || fail WORKBUDDY_BUNDLE_DESTINATION_INVALID
shopt -s nullglob dotglob
entries=("$destination"/*)
[[ ${#entries[@]} -eq 0 ]] || fail WORKBUDDY_BUNDLE_DESTINATION_NOT_EMPTY
destination="$(cd -- "$destination" && pwd -P)"
partial="$destination/WorkBuddy.dmg.partial"
trap 'rm -f -- "$partial" 2>/dev/null' EXIT

# The official download page converts its update-feed ZIP URL to this DMG URL.
url="https://download.codebuddy.cn/workbuddy/saas/darwin-$arch/WorkBuddy-darwin-$arch-$desktop_version-37a65c0b.dmg"
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
printf '{"desktopVersion":"%s","runtimeVersion":"%s","arch":"%s","sha256":"%s","file":"WorkBuddy.dmg"}\n' \
  "$desktop_version" "$runtime_version" "$arch" "$sha256"

#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || $# -ne 2 ]]; then
  echo "Usage (macOS): scripts/macos-codex-install-check.sh TARBALL_DIR CODEX_VERSION" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tarball_dir="$(cd "$1" && pwd)"
codex_version="$2"
[[ "$codex_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "CODEX_VERSION must be an exact stable version." >&2
  exit 1
}
set -- "$tarball_dir"/memorax-memorax-code-*.tgz
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Expected exactly one MemoraX Code tarball; run make npm-package-check first." >&2
  exit 1
fi
tarball="$1"
test_root="$(mktemp -d)"
mkdir -p "$test_root/user" "$test_root/tmp"

isolated() {
  env -i PATH="$PATH" HOME="$test_root/user" \
    MEMORAX_CODE_HOME="$test_root/state" CODEX_HOME="$test_root/codex" \
    MEMORAX_CODE_AUTO_UPDATE=false MEMORAX_CODE_INSTALL_WATCHDOG=0 \
    npm_config_cache="$test_root/npm-cache" TMPDIR="$test_root/tmp" "$@"
}

# Use npm lifecycle scripts exactly as a normal package installation would.
isolated npm install --global --prefix "$test_root/npm" --no-audit --no-fund \
  "@openai/codex@$codex_version" "$tarball"
isolated "$test_root/npm/bin/memorax-code" --help >/dev/null
isolated "$test_root/npm/bin/codex" --version
isolated node "$repo_root/scripts/codex-install-smoke.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/codex"

# The smoke runner confirms Backend shutdown before removing its own state.
# Retain this install on failure so any remaining process keeps its runtime.
rm -rf "$test_root"

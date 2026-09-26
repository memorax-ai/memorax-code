#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || ! "$(uname -s)" =~ ^(Darwin|Linux)$ ]]; then
  echo "Usage (macOS/Linux): scripts/codex-install-check.sh TARBALL_DIR CODEX_VERSION [PREVIOUS_VERSION]" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tarball_dir="$(cd "$1" && pwd)"
codex_version="$2"
previous_version="${3:-0.1.17}"
npm_command="$(command -v npm)"
[[ "$previous_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "PREVIOUS_VERSION must be an exact stable version." >&2
  exit 1
}
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
mkdir -p "$test_root/user" "$test_root/tmp" "$test_root/npm"
printf 'codex-install-check\n' > "$test_root/npm/.memorax-code-ci-owned"

isolated() {
  env -i PATH="$PATH" HOME="$test_root/user" \
    MEMORAX_CODE_HOME="$test_root/state" CODEX_HOME="$test_root/codex" \
    MEMORAX_CODE_AUTO_UPDATE=false MEMORAX_CODE_INSTALL_WATCHDOG=0 \
    npm_config_cache="$test_root/npm-cache" TMPDIR="$test_root/tmp" "$@"
}

# Use npm lifecycle scripts exactly as a normal package installation would.
isolated npm install --global --prefix "$test_root/npm" --no-audit --no-fund \
  "@openai/codex@$codex_version" "$tarball"
isolated npm install --prefix "$test_root/terminal" --no-audit --no-fund node-pty@1.1.0
isolated "$test_root/npm/bin/memorax-code" --help >/dev/null
isolated "$test_root/npm/bin/codex" --version
isolated node "$repo_root/scripts/codex-install-smoke.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/codex" "$tarball" "$npm_command" "$previous_version" \
  "$test_root/terminal/node_modules/node-pty" "$repo_root/scripts/codex-setup-pty.mjs"
isolated node "$repo_root/scripts/codex-native-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" "$test_root/npm/bin/codex"
isolated node "$repo_root/scripts/codex-permissions-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" "$test_root/npm/bin/codex"

# The smoke runner confirms Backend shutdown before removing its own state.
# Retain this install on failure so any remaining process keeps its runtime.
rm -rf "$test_root"

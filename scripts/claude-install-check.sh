#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || ! "$(uname -s)" =~ ^(Darwin|Linux)$ ]]; then
  echo 'Usage (macOS/Linux): bash scripts/claude-install-check.sh TARBALL_DIR CLAUDE_VERSION [PREVIOUS_VERSION]' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tarball_dir="$(cd "$1" && pwd)"
claude_version="$2"
previous_version="${3:-0.1.18}"
npm_command="$(command -v npm)"
for version in "$claude_version" "$previous_version"; do
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo 'Client and previous package versions must be exact stable versions.' >&2
    exit 1
  }
done
set -- "$tarball_dir"/memorax-memorax-code-*.tgz
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo 'Expected exactly one MemoraX Code tarball; run make npm-package-check first.' >&2
  exit 1
fi
tarball="$1"
test_root="$(mktemp -d)"
mkdir -p "$test_root/user" "$test_root/tmp" "$test_root/npm" "$test_root/claude"
printf 'claude-install-check\n' > "$test_root/npm/.memorax-code-ci-owned"
active_pid=''

interrupt() {
  trap - INT TERM
  if [[ -n "$active_pid" ]]; then
    kill -s "$1" "$active_pid" 2>/dev/null || true
    wait "$active_pid" || true
  fi
  exit "$2"
}
trap 'interrupt INT 130' INT
trap 'interrupt TERM 143' TERM

isolated() {
  env -i PATH="$PATH" HOME="$test_root/user" \
    MEMORAX_CODE_HOME="$test_root/state" CLAUDE_CONFIG_DIR="$test_root/claude" \
    MEMORAX_CODE_AUTO_UPDATE=false MEMORAX_CODE_INSTALL_WATCHDOG=0 \
    DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    npm_config_cache="$test_root/npm-cache" \
    npm_config_userconfig="$test_root/npm-user.config" \
    npm_config_globalconfig="$test_root/npm-global.config" \
    TMPDIR="$test_root/tmp" "$@" &
  active_pid=$!
  local status=0
  wait "$active_pid" || status=$?
  active_pid=''
  return "$status"
}

# Keep local npm configuration and client discovery outside the checkout.
cd "$test_root/user"
if ! isolated npm install --global --prefix "$test_root/npm" --no-audit --no-fund \
  --registry=https://registry.npmjs.org/ "@anthropic-ai/claude-code@$claude_version" "$tarball" \
  > "$test_root/npm-install.log" 2>&1; then
  echo 'npm installation failed; isolated state retained.' >&2
  exit 1
fi
if [[ -e "$test_root/state/config.toml" || -e "$test_root/state/runtime/backend/backend.pid.json" ]]; then
  echo 'Fresh package installation unexpectedly configured or started MemoraX Code.' >&2
  exit 1
fi
if ! isolated npm install --prefix "$test_root/terminal" --no-audit --no-fund \
  --registry=https://registry.npmjs.org/ node-pty@1.1.0 \
  > "$test_root/npm-terminal-install.log" 2>&1; then
  echo 'The test-only terminal dependency installation failed; isolated state retained.' >&2
  exit 1
fi
if ! isolated "$test_root/npm/bin/memorax-code" --help > "$test_root/product-help.log" 2>&1; then
  echo 'The installed MemoraX Code command shim failed.' >&2
  exit 1
fi
if ! version_output="$(isolated "$test_root/npm/bin/claude" --version 2> "$test_root/claude-version.log")"; then
  echo 'The installed Claude Code command shim failed.' >&2
  exit 1
fi
[[ "$version_output" == "$claude_version (Claude Code)" ]] || {
  echo 'Installed Claude Code version does not match the requested version.' >&2
  exit 1
}
printf 'Claude Code requested: %s; installed: %s\n' "$claude_version" "$claude_version"

isolated node "$repo_root/scripts/claude-install-smoke.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$tarball" "$npm_command" "$previous_version" \
  "$test_root/terminal/node_modules/node-pty" "$repo_root/scripts/claude-setup-pty.mjs" "$claude_version"
isolated node "$repo_root/scripts/claude-install-interruption-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$test_root/terminal/node_modules/node-pty" "$claude_version"
isolated node "$repo_root/scripts/claude-native-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$claude_version"
isolated node "$repo_root/scripts/claude-permissions-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$claude_version"

# Each suite confirms owned process cleanup before removing this runtime.
rm -rf "$test_root"

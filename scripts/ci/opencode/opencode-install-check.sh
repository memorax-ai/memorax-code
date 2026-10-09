#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || ! "$(uname -s)" =~ ^(Darwin|Linux)$ ]]; then
  echo "Usage (macOS/Linux): bash scripts/ci/opencode/opencode-install-check.sh TARBALL_DIR OPENCODE_VERSION [PREVIOUS_VERSION]" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tarball_dir="$(cd "$1" && pwd)"
opencode_version="$2"
previous_version="${3:-0.1.18}"
npm_command="$(command -v npm)"
for version in "$opencode_version" "$previous_version"; do
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
mkdir -p "$test_root/user" "$test_root/tmp" "$test_root/npm" "$test_root/opencode"
printf 'opencode-install-check\n' > "$test_root/npm/.memorax-code-ci-owned"
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
    MEMORAX_CODE_HOME="$test_root/state" OPENCODE_CONFIG_DIR="$test_root/opencode" \
    MEMORAX_CODE_AUTO_UPDATE=false MEMORAX_CODE_INSTALL_WATCHDOG=0 \
    npm_config_cache="$test_root/npm-cache" MEMORAX_CODE_TEST_NPM_CACHE="$test_root/npm-cache" \
    TMPDIR="$test_root/tmp" "$@" &
  active_pid=$!
  local status=0
  wait "$active_pid" || status=$?
  active_pid=''
  return "$status"
}

isolated npm install --global --prefix "$test_root/npm" --no-audit --no-fund \
  "opencode-ai@$opencode_version" "$tarball"
isolated npm install --prefix "$test_root/terminal" --no-audit --no-fund node-pty@1.1.0 @vscode/ripgrep@1.18.0
rg_command="$(isolated node -e 'process.stdout.write(require(process.argv[1]).rgPath)' "$test_root/terminal/node_modules/@vscode/ripgrep")"
PATH="$(dirname "$rg_command"):$PATH"
isolated "$rg_command" --version >/dev/null
isolated "$test_root/npm/bin/memorax-code" --help >/dev/null
actual_version="$(isolated "$test_root/npm/bin/opencode" --version)"
[[ "$actual_version" == "$opencode_version" ]] || {
  echo 'Installed OpenCode version does not match the requested version.' >&2
  exit 1
}
printf 'OpenCode requested: %s; installed: %s\n' "$opencode_version" "$actual_version"

package_root="$test_root/npm/lib/node_modules/@memorax/memorax-code"
opencode="$test_root/npm/bin/opencode"
isolated node "$repo_root/scripts/ci/opencode/opencode-install-smoke.mjs" \
  "$package_root" "$opencode" "$tarball" "$npm_command" "$previous_version" \
  "$test_root/terminal/node_modules/node-pty" "$repo_root/scripts/ci/opencode/opencode-setup-pty.mjs" "$opencode_version"
isolated node "$repo_root/scripts/ci/opencode/opencode-native-check.mjs" "$package_root" "$opencode"
isolated node "$repo_root/scripts/ci/opencode/opencode-permissions-check.mjs" "$package_root" "$opencode"
isolated node "$repo_root/scripts/ci/opencode/opencode-server-check.mjs" "$package_root" "$opencode"
isolated node "$repo_root/scripts/ci/opencode/opencode-install-interruption-check.mjs" \
  "$package_root" "$opencode" "$test_root/terminal/node_modules/node-pty"

# Each suite verifies its owned processes have stopped before this runtime is removed.
rm -rf "$test_root"

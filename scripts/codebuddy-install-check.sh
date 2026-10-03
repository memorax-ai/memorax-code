#!/usr/bin/env bash
set -euo pipefail

if [[ ( $# -ne 2 && $# -ne 3 && $# -ne 5 ) || ! "$(uname -s)" =~ ^(Darwin|Linux)$ ]]; then
  echo 'Usage (macOS/Linux): bash scripts/codebuddy-install-check.sh TARBALL_DIR RUNTIME_VERSION [PREVIOUS_VERSION [workbuddy BUNDLED_COMMAND]]' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tarball_dir="$(cd "$1" && pwd)"
codebuddy_version="$2"
previous_version="${3:-0.1.18}"
client="${4:-codebuddy}"
native_command="${5:-}"
if [[ "$client" != codebuddy && "$client" != workbuddy ]] || [[ $# -eq 5 && "$client" != workbuddy ]]; then
  echo 'Only the explicit WorkBuddy mode accepts a bundled command.' >&2
  exit 1
fi
if [[ "$client" == workbuddy ]]; then
  native_command="$(cd "$(dirname "$native_command")" && pwd)/$(basename "$native_command")"
  node "$repo_root/scripts/workbuddy-bundled-command-check.mjs" "$native_command"
fi
npm_command="$(command -v npm)"
for version in "$codebuddy_version" "$previous_version"; do
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
mkdir -p "$test_root/user" "$test_root/tmp" "$test_root/npm" "$test_root/$client"
printf '%s-install-check\n' "$client" > "$test_root/npm/.memorax-code-ci-owned"
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
  local client_env=(CODEBUDDY_CONFIG_DIR="$test_root/$client")
  if [[ "$client" == workbuddy ]]; then
    client_env+=(WORKBUDDY_HOME="$test_root/workbuddy" WORKBUDDY_CONFIG_DIR="$test_root/workbuddy" CODEBUDDY_HOME="$test_root/user/.codebuddy")
  fi
  env -i PATH="$PATH" HOME="$test_root/user" \
    MEMORAX_CODE_HOME="$test_root/state" \
    "${client_env[@]}" \
    MEMORAX_CODE_AUTO_UPDATE=false MEMORAX_CODE_INSTALL_WATCHDOG=0 \
    DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \
    CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1 CODEBUDDY_DISABLE_AUTO_MEMORY=1 \
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

cleanup_failed_install() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then
    isolated node "$repo_root/scripts/codebuddy-install-cleanup.mjs" \
      "$test_root/state" "$test_root/npm/bin/memorax-code" "" "$client" || true
  fi
  exit "$status"
}
trap cleanup_failed_install EXIT

cd "$test_root/user"
packages=("$tarball")
if [[ "$client" == codebuddy ]]; then
  packages=("@tencent-ai/codebuddy-code@$codebuddy_version" "$tarball")
  native_command="$test_root/npm/bin/codebuddy"
fi
if ! isolated npm install --global --prefix "$test_root/npm" --no-audit --no-fund \
  --registry=https://registry.npmjs.org/ "${packages[@]}" \
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
if ! isolated "$test_root/npm/bin/memorax-cli" --help > "$test_root/memory-help.log" 2>&1; then
  echo 'The installed MemoraX memory command shim failed.' >&2
  exit 1
fi
if ! version_output="$(isolated "$native_command" --version 2> "$test_root/codebuddy-version.log")"; then
  echo 'The installed CodeBuddy Code command shim failed.' >&2
  exit 1
fi
[[ "$version_output" == "$codebuddy_version" ]] || {
  echo 'Installed CodeBuddy Code version does not match the requested version.' >&2
  exit 1
}
printf '%s runtime requested: %s; installed: %s\n' "$client" "$codebuddy_version" "$codebuddy_version"

isolated node "$repo_root/scripts/codebuddy-lifecycle-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$native_command" "$tarball" "$npm_command" "$previous_version" \
  "$test_root/terminal/node_modules/node-pty" "$repo_root/scripts/codebuddy-setup-pty.mjs" "$codebuddy_version" "$client"
isolated node "$repo_root/scripts/codebuddy-install-interruption-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$native_command" "$test_root/terminal/node_modules/node-pty" "$codebuddy_version" "$client"
isolated node "$repo_root/scripts/$client-native-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$native_command" "$codebuddy_version"
if [[ "$client" == codebuddy ]]; then
  isolated node "$repo_root/scripts/codebuddy-background-check.mjs" \
    "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
    "$test_root/npm/bin/codebuddy" "$codebuddy_version"
  isolated node "$repo_root/scripts/codebuddy-permissions-check.mjs" \
    "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
    "$test_root/npm/bin/codebuddy" "$codebuddy_version"
else
  printf 'WorkBuddy permissions and Repo Memory worker coverage are not implemented in this runner.\n'
fi

# Each suite confirms owned-process cleanup before removing this runtime.
rm -rf "$test_root"

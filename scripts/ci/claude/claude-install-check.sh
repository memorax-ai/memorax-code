#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || ! "$(uname -s)" =~ ^(Darwin|Linux)$ ]]; then
  echo 'Usage (macOS/Linux): bash scripts/ci/claude/claude-install-check.sh TARBALL_DIR CLAUDE_VERSION [PREVIOUS_VERSION]' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
evidence_dir="${MEMORAX_CI_EVIDENCE_DIR:-}"
evidence_tool="$repo_root/scripts/ci/shared/ci-evidence.mjs"
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

# Evidence lives outside the isolated runtime; an unusable location disables it without affecting the suites.
if [[ -n "$evidence_dir" ]] && ! evidence_dir="$(node "$evidence_tool" prepare "$evidence_dir" "$test_root")"; then
  echo 'CI evidence disabled: the evidence directory is unusable.' >&2
  evidence_dir=''
fi
ledger() {
  [[ -z "$evidence_dir" ]] || node "$evidence_tool" ledger "$evidence_dir" "$@" \
    || echo 'CI evidence ledger could not be updated.' >&2
}
# Only the test runners receive the evidence location; npm and product commands do not.
isolated_suite() {
  isolated env MEMORAX_CI_EVIDENCE_DIR="$evidence_dir" "$@"
}
run_suite() {
  local suite="$1" status=0
  shift
  ledger start "$suite"
  "$@" || status=$?
  ledger end "$suite" "$status"
  return "$status"
}
planned_suites=claude-install-smoke,claude-install-interruption-check,claude-native-check,claude-permissions-check
finish() {
  local status=$?
  ledger finalize "$planned_suites"
  if [[ "$status" -ne 0 ]]; then
    echo "The Claude functional wrapper stopped with exit $status; its runtime stays on this runner and is not exported. Evidence: ${evidence_dir:-not configured}." >&2
  fi
}
trap finish EXIT
ledger plan "$planned_suites"
ledger phase setup

# Keep local npm configuration and client discovery outside the checkout.
cd "$test_root/user"
if ! isolated npm install --global --prefix "$test_root/npm" --no-audit --no-fund \
  --registry=https://registry.npmjs.org/ "@anthropic-ai/claude-code@$claude_version" "$tarball" \
  > "$test_root/npm-install.log" 2>&1; then
  echo 'npm installation failed; its runtime stays on this runner and is not exported.' >&2
  exit 1
fi
if [[ -e "$test_root/state/config.toml" || -e "$test_root/state/runtime/backend/backend.pid.json" ]]; then
  echo 'Fresh package installation unexpectedly configured or started MemoraX Code.' >&2
  exit 1
fi
if ! isolated npm install --prefix "$test_root/terminal" --no-audit --no-fund \
  --registry=https://registry.npmjs.org/ node-pty@1.1.0 \
  > "$test_root/npm-terminal-install.log" 2>&1; then
  echo 'The test-only terminal dependency installation failed; its runtime stays on this runner and is not exported.' >&2
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

ledger phase suites
run_suite claude-install-smoke isolated_suite node "$repo_root/scripts/ci/claude/claude-install-smoke.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$tarball" "$npm_command" "$previous_version" \
  "$test_root/terminal/node_modules/node-pty" "$repo_root/scripts/ci/claude/claude-setup-pty.mjs" "$claude_version"
run_suite claude-install-interruption-check isolated_suite node "$repo_root/scripts/ci/claude/claude-install-interruption-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$test_root/terminal/node_modules/node-pty" "$claude_version"
run_suite claude-native-check isolated_suite node "$repo_root/scripts/ci/claude/claude-native-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$claude_version"
run_suite claude-permissions-check isolated_suite node "$repo_root/scripts/ci/claude/claude-permissions-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/claude" "$claude_version"

# Each suite confirms owned process cleanup before removing this runtime.
ledger phase cleanup
rm -rf "$test_root"

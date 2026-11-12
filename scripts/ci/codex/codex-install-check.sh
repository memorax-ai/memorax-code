#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || ! "$(uname -s)" =~ ^(Darwin|Linux)$ ]]; then
  echo "Usage (macOS/Linux): scripts/ci/codex/codex-install-check.sh TARBALL_DIR CODEX_VERSION [PREVIOUS_VERSION]" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Capture the evidence location before every command below runs with a cleared environment.
evidence_dir="${MEMORAX_CI_EVIDENCE_DIR:-}"
evidence_tool="$repo_root/scripts/ci/shared/ci-evidence.mjs"
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
mkdir -p "$test_root/user" "$test_root/tmp" "$test_root/npm" "$test_root/codex"
printf 'codex-install-check\n' > "$test_root/npm/.memorax-code-ci-owned"

isolated() {
  env -i PATH="$PATH" HOME="$test_root/user" \
    MEMORAX_CODE_HOME="$test_root/state" CODEX_HOME="$test_root/codex" \
    MEMORAX_CODE_AUTO_UPDATE=false MEMORAX_CODE_INSTALL_WATCHDOG=0 \
    npm_config_cache="$test_root/npm-cache" TMPDIR="$test_root/tmp" "$@"
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
planned_suites=codex-install-smoke,codex-native-check,codex-permissions-check,codex-install-interruption-check
finish() {
  local status=$?
  ledger finalize "$planned_suites"
  if [[ "$status" -ne 0 ]]; then
    echo "The Codex functional wrapper stopped with exit $status; its runtime stays on this runner and is not exported. Evidence: ${evidence_dir:-not configured}." >&2
  fi
}
trap finish EXIT
ledger plan "$planned_suites"
ledger phase setup
ledger skip codex-model-inheritance-check pending_implementation

# Use npm lifecycle scripts exactly as a normal package installation would.
isolated npm install --global --prefix "$test_root/npm" --no-audit --no-fund \
  "@openai/codex@$codex_version" "$tarball"
isolated npm install --prefix "$test_root/terminal" --no-audit --no-fund node-pty@1.1.0
isolated "$test_root/npm/bin/memorax-code" --help >/dev/null
isolated "$test_root/npm/bin/codex" --version
ledger phase suites
run_suite codex-install-smoke isolated_suite node "$repo_root/scripts/ci/codex/codex-install-smoke.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$test_root/npm/bin/codex" "$tarball" "$npm_command" "$previous_version" \
  "$test_root/terminal/node_modules/node-pty" "$repo_root/scripts/ci/codex/codex-setup-pty.mjs" "$codex_version"
run_suite codex-native-check isolated_suite node "$repo_root/scripts/ci/codex/codex-native-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" "$test_root/npm/bin/codex"
run_suite codex-permissions-check isolated_suite node "$repo_root/scripts/ci/codex/codex-permissions-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" "$test_root/npm/bin/codex"
run_suite codex-install-interruption-check isolated_suite node "$repo_root/scripts/ci/codex/codex-install-interruption-check.mjs" \
  "$test_root/npm/lib/node_modules/@memorax/memorax-code" "$test_root/npm/bin/codex" \
  "$test_root/terminal/node_modules/node-pty"
echo 'SKIP: foreground model/provider override inheritance is pending implementation (see CONTRIBUTING.md).'

# The smoke runner confirms Backend shutdown before removing its own state.
# Retain this install on failure so any remaining process keeps its runtime.
ledger phase cleanup
rm -rf "$test_root"

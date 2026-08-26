#!/usr/bin/env bash
set -euo pipefail

artifact_root="${1:-dist/npm-linux}"
report_path="${2:-$artifact_root/linux-lifecycle-report.json}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux npm registry lifecycle E2E requires a Linux host" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

artifact_root="$(realpath "$artifact_root")"
report_path="$(realpath -m "$report_path")"
baseline_report="$artifact_root/main-pack.json"
next_report="$artifact_root/next-pack.json"
test -f "$baseline_report"
test -f "$next_report"

mapfile -t package_metadata < <(
  node --input-type=module - "$baseline_report" "$next_report" <<'NODE'
import { readFileSync } from "node:fs";

const reports = process.argv.slice(2).map((path) => {
  const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack report must contain exactly one package");
  }
  return parsed[0];
});
const [baseline, next] = reports;
if (baseline.name !== "@memorax/memorax-code"
  || next.name !== "@memorax/memorax-code"
  || typeof baseline.version !== "string"
  || typeof next.version !== "string"
  || baseline.version === next.version
  || typeof baseline.filename !== "string"
  || typeof next.filename !== "string") {
  throw new Error("Linux lifecycle artifacts have invalid package identity or versions");
}
process.stdout.write([
  baseline.version,
  baseline.filename,
  next.version,
  next.filename,
].join("\n"));
NODE
)

test "${#package_metadata[@]}" -eq 4
baseline_version="${package_metadata[0]}"
baseline_filename="${package_metadata[1]}"
next_version="${package_metadata[2]}"
next_filename="${package_metadata[3]}"
baseline_tarball="$artifact_root/tarballs/$baseline_filename"
next_tarball="$artifact_root/tarballs/$next_filename"
test -f "$baseline_tarball"
test -f "$next_tarball"

verdaccio_bin="$(command -v verdaccio)"
test -n "$verdaccio_bin"

e2e_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/memorax-code-linux-npm.XXXXXX")"
isolated_root="$e2e_root/MemoraX Code Linux 中文"
registry_root="$isolated_root/registry"
npm_prefix="$isolated_root/npm prefix"
workspace="$isolated_root/workspace"
registry_port=4873
backend_port=18787
registry_pid=""
memorax_code_bin=""
known_backend_pids=()

cleanup() {
  if [[ -n "$memorax_code_bin" && -x "$memorax_code_bin" ]]; then
    "$memorax_code_bin" stop --json --clients none --port "$backend_port" >/dev/null 2>&1 || true
  fi
  for pid in "${known_backend_pids[@]}"; do
    if [[ -r "/proc/$pid/cmdline" ]] \
      && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq "$npm_prefix"; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  if [[ -n "$registry_pid" ]]; then
    kill "$registry_pid" >/dev/null 2>&1 || true
    wait "$registry_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$e2e_root" && "$e2e_root" != "/" && -d "$e2e_root" ]]; then
    rm -rf "$e2e_root"
  fi
}
trap cleanup EXIT

export HOME="$isolated_root/home"
export CODEX_HOME="$isolated_root/codex home"
export CLAUDE_CONFIG_DIR="$isolated_root/claude home"
export CLAUDE_HOME="$CLAUDE_CONFIG_DIR"
export MEMORAX_CODE_HOME="$isolated_root/memorax-code home"
export NPM_CONFIG_PREFIX="$npm_prefix"
export NPM_CONFIG_CACHE="$isolated_root/npm cache"
export NPM_CONFIG_USERCONFIG="$isolated_root/npmrc"
export NPM_CONFIG_REGISTRY="http://127.0.0.1:$registry_port"
export NPM_CONFIG_UPDATE_NOTIFIER=false
export NPM_CONFIG_FUND=false
export NPM_CONFIG_AUDIT=false
export MEMORAX_CODE_BACKEND_PORT="$backend_port"
export PATH="$npm_prefix/bin:$PATH"

mkdir -p \
  "$registry_root" \
  "$workspace" \
  "$HOME" \
  "$CODEX_HOME" \
  "$CLAUDE_CONFIG_DIR" \
  "$MEMORAX_CODE_HOME"

printf '%s\n' \
  'storage: ./storage' \
  'auth:' \
  '  htpasswd:' \
  '    file: ./htpasswd' \
  '    max_users: -1' \
  'uplinks:' \
  '  npmjs:' \
  '    url: https://registry.npmjs.org/' \
  'packages:' \
  "  '@memorax/*':" \
  "    access: \$all" \
  "    publish: \$all" \
  "  '**':" \
  "    access: \$all" \
  "    publish: \$all" \
  '    proxy: npmjs' \
  'log: { type: stdout, format: pretty, level: warn }' \
  >"$registry_root/config.yaml"

"$verdaccio_bin" \
  --config "$registry_root/config.yaml" \
  --listen "127.0.0.1:$registry_port" \
  >"$registry_root/verdaccio.log" 2>&1 &
registry_pid="$!"

registry_ready=0
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:$registry_port/-/ping" >/dev/null; then
    registry_ready=1
    break
  fi
  sleep 0.25
done
if [[ "$registry_ready" != "1" ]]; then
  tail -n 80 "$registry_root/verdaccio.log" >&2
  echo "isolated npm registry did not become ready" >&2
  exit 1
fi

npm config set "//127.0.0.1:$registry_port/:_authToken" ci-token
update_channel=latest
if [[ "$baseline_version" == *-* ]]; then
  update_channel=preview
fi
npm publish "$baseline_tarball" --access public --tag "$update_channel" --loglevel warn
npm publish "$next_tarball" --access public --tag "$update_channel" --loglevel warn

cd "$workspace"
npm install -g "@memorax/memorax-code@$baseline_version" --loglevel warn

package_install_root="$npm_prefix/lib/node_modules/@memorax/memorax-code"
memorax_code_bin="$npm_prefix/bin/memorax-code"
test -d "$package_install_root"
test -x "$memorax_code_bin"
test -f "$package_install_root/node_modules/smol-toml/package.json"
test ! -e "$package_install_root/node_modules/typescript/package.json"
test "$("$memorax_code_bin" --version)" = "memorax-code $baseline_version"
for command in memorax-code memorax-cli memorax-code-backend memorax-code-codex memorax-code-claude memorax-code-opencode; do
  test -x "$npm_prefix/bin/$command"
  "$npm_prefix/bin/$command" --help >/dev/null
done

test ! -e "$MEMORAX_CODE_HOME/config.toml"
test ! -e "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json"
test ! -e "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json"
test ! -e "$MEMORAX_CODE_HOME/runtime/install/package-transition.json"
if "$memorax_code_bin" >"$isolated_root/before-setup.stdout" 2>"$isolated_root/before-setup.stderr"; then
  echo "Linux lifecycle E2E: no-argument CLI unexpectedly accepted incomplete setup" >&2
  exit 1
fi
grep -Fq 'setup has not been completed' "$isolated_root/before-setup.stderr"

printf '%s\n' 'linux-e2e-user' 'linux-e2e-key' | \
  MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE=1 \
  MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL=1 \
  MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL=1 \
  MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL=1 \
  "$memorax_code_bin" setup --existing-account \
    >"$isolated_root/setup.stdout" 2>"$isolated_root/setup.stderr"
node --input-type=module - "$MEMORAX_CODE_HOME/config.toml" <<'NODE_DISABLE_DSH'
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const source = readFileSync(path, "utf8");
const updated = source.replace(/^dsh = true\b.*$/m, "dsh = false # Disabled for the stopped-reinstall lifecycle check.");
if (updated === source) throw new Error("Linux lifecycle E2E could not disable DSH in generated config");
writeFileSync(path, updated, { mode: 0o600 });
NODE_DISABLE_DSH
test -f "$MEMORAX_CODE_HOME/config.toml"
test -f "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json"
test -f "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json"
test ! -e "$MEMORAX_CODE_HOME/runtime/install/package-transition.json"
node --input-type=module - \
  "$MEMORAX_CODE_HOME/config.toml" \
  "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json" \
  "$baseline_version" <<'NODE'
import { readFileSync } from "node:fs";

const config = readFileSync(process.argv[2], "utf8");
const completion = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (!config.includes('user_id = "linux-e2e-user"')
  || !config.includes('api_key = "linux-e2e-key"')
  || !config.includes("codex = false")
  || !config.includes("claude = false")
  || !config.includes("dsh = false")
  || !config.includes("opencode = false")) {
  throw new Error("explicit setup did not write the expected isolated configuration");
}
if (completion?.version !== 1
  || completion?.state !== "complete"
  || completion?.completedByVersion !== process.argv[4]) {
  throw new Error("explicit setup did not commit the expected completion record");
}
NODE

printf '\n[linux_e2e_sentinel]\nvalue = "preserve-v1"\n' \
  >>"$MEMORAX_CODE_HOME/config.toml"
mkdir -p "$MEMORAX_CODE_HOME/memory" "$MEMORAX_CODE_HOME/user-state"
printf 'memory-preserve-v1\0\1' >"$MEMORAX_CODE_HOME/memory/e2e-sentinel.bin"
printf 'user-state-preserve-v1\n' >"$MEMORAX_CODE_HOME/user-state/e2e-sentinel.txt"
config_hash="$(sha256sum "$MEMORAX_CODE_HOME/config.toml" | cut -d' ' -f1)"
memory_hash="$(sha256sum "$MEMORAX_CODE_HOME/memory/e2e-sentinel.bin" | cut -d' ' -f1)"
user_state_hash="$(sha256sum "$MEMORAX_CODE_HOME/user-state/e2e-sentinel.txt" | cut -d' ' -f1)"

sentinels_match() {
  [[ "$(sha256sum "$MEMORAX_CODE_HOME/config.toml" | cut -d' ' -f1)" == "$config_hash" ]] \
    && [[ "$(sha256sum "$MEMORAX_CODE_HOME/memory/e2e-sentinel.bin" | cut -d' ' -f1)" == "$memory_hash" ]] \
    && [[ "$(sha256sum "$MEMORAX_CODE_HOME/user-state/e2e-sentinel.txt" | cut -d' ' -f1)" == "$user_state_hash" ]]
}

json_pid() {
  node --input-type=module - "$1" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pid = report?.backend?.state?.pid;
if (!Number.isSafeInteger(pid) || pid <= 0) {
  throw new Error("lifecycle report did not contain a safe Backend PID");
}
process.stdout.write(String(pid));
NODE
}

assert_backend_status() {
  node --input-type=module - "$1" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (report?.backend?.ok !== true || report?.backend?.service !== "memorax-code-backend") {
  throw new Error("Backend status was not healthy");
}
NODE
}

wait_for_exit() {
  local pid="$1"
  for _ in $(seq 1 100); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  ! kill -0 "$pid" >/dev/null 2>&1
}

assert_port_released() {
  node --input-type=module - "$backend_port" <<'NODE'
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const server = createServer();
server.once("error", () => process.exit(1));
server.listen(port, "127.0.0.1", () => {
  server.close((error) => process.exit(error ? 1 : 0));
});
NODE
}

backend_state="$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json"
"$memorax_code_bin" stop --json --clients none --port "$backend_port" \
  >"$isolated_root/initial-stop.json"
test ! -e "$backend_state"

npm install -g "@memorax/memorax-code@$baseline_version" --loglevel warn
test ! -e "$backend_state"
test -f "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json"
test ! -e "$MEMORAX_CODE_HOME/runtime/install/package-transition.json"
assert_port_released

"$memorax_code_bin" start --json --clients none --port "$backend_port" \
  >"$isolated_root/start.json"
started_pid="$(json_pid "$isolated_root/start.json")"
known_backend_pids+=("$started_pid")
"$memorax_code_bin" status --json --clients none --port "$backend_port" \
  >"$isolated_root/status.json"
assert_backend_status "$isolated_root/status.json"

"$memorax_code_bin" restart --json --clients none --port "$backend_port" \
  >"$isolated_root/restart.json"
restarted_pid="$(json_pid "$isolated_root/restart.json")"
known_backend_pids+=("$restarted_pid")
test "$restarted_pid" != "$started_pid"
wait_for_exit "$started_pid"

"$memorax_code_bin" stop --json --clients none --port "$backend_port" \
  >"$isolated_root/stop.json"
wait_for_exit "$restarted_pid"
assert_port_released

"$memorax_code_bin" start --json --clients none --port "$backend_port" \
  >"$isolated_root/update-start.json"
pre_update_pid="$(json_pid "$isolated_root/update-start.json")"
known_backend_pids+=("$pre_update_pid")

"$memorax_code_bin" update
test "$("$memorax_code_bin" --version)" = "memorax-code $next_version"
wait_for_exit "$pre_update_pid"

updated_pid="$(
  node --input-type=module - "$backend_state" "$pre_update_pid" <<'NODE'
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(process.argv[2], "utf8"));
const oldPid = Number(process.argv[3]);
if (!Number.isSafeInteger(state?.pid) || state.pid <= 0 || state.pid === oldPid) {
  throw new Error("package update did not replace the Backend PID");
}
const response = await fetch(new URL("/health", state.url), {
  signal: AbortSignal.timeout(2_000),
});
const health = response.ok ? await response.json() : {};
if (health.service !== "memorax-code-backend" || health.instanceId !== state.instanceId) {
  throw new Error("updated Backend was not healthy");
}
process.stdout.write(String(state.pid));
NODE
)"
known_backend_pids+=("$updated_pid")

"$memorax_code_bin" uninstall --json --clients none --no-npm-uninstall \
  --port "$backend_port" >"$isolated_root/partial-uninstall.json"
node --input-type=module - "$isolated_root/partial-uninstall.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (report?.ok !== true
  || report?.npmPackageRemoval?.ok !== true
  || report?.npmPackageRemoval?.skipped !== true
  || report?.npmPackageRemoval?.reason !== "disabled_by_flag") {
  throw new Error("partial uninstall did not preserve the npm package");
}
NODE
wait_for_exit "$updated_pid"
assert_port_released
test -d "$package_install_root"
test -x "$memorax_code_bin"
sentinels_match
test ! -e "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json"

"$memorax_code_bin" start --json --clients none --port "$backend_port" \
  >"$isolated_root/final-start.json"
final_pid="$(json_pid "$isolated_root/final-start.json")"
known_backend_pids+=("$final_pid")

"$memorax_code_bin" uninstall --json --clients none --port "$backend_port" \
  >"$isolated_root/full-uninstall.json"
node --input-type=module - "$isolated_root/full-uninstall.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (report?.ok !== true
  || report?.npmPackageRemoval?.ok !== true
  || report?.npmPackageRemoval?.skipped === true) {
  throw new Error("full uninstall did not remove the npm package");
}
NODE
wait_for_exit "$final_pid"
assert_port_released
test ! -e "$package_install_root"
test ! -e "$memorax_code_bin"
test -d "$MEMORAX_CODE_HOME"
sentinels_match

mkdir -p "$(dirname "$report_path")"
node --input-type=module - "$report_path" "$baseline_version" "$next_version" <<'NODE'
import { writeFileSync } from "node:fs";

const [path, baselineVersion, updatedVersion] = process.argv.slice(2);
const report = {
  npmInstallOk: true,
  npmInstallStayedUninitialized: true,
  packageIdentityExact: true,
  productionDependencyReady: true,
  binShimsRunnable: true,
  explicitSetupCompleted: true,
  explicitSetupWroteConfig: true,
  stoppedReinstallStayedStopped: true,
  backendStartHealthy: true,
  restartReplacedPid: true,
  stopRemovedProcess: true,
  stopReleasedPort: true,
  updateInstalledNewVersion: true,
  updateReplacedPid: true,
  updatedBackendHealthy: true,
  partialUninstallKeptPackage: true,
  partialUninstallKeptState: true,
  completeUninstallClearedSetupCompletion: true,
  fullUninstallRemovedPackage: true,
  fullUninstallRemovedProcess: true,
  fullUninstallReleasedPort: true,
  userStatePreserved: true,
  sentinelBytesPreserved: true,
  sameIdentityUpdate: true,
  baselineVersion,
  updatedVersion,
};
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
NODE

node --input-type=module - "$report_path" <<'NODE'
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2], "utf8");
if (/Authorization|Bearer|api[_-]?key|token|\/(?:Users|home)\//i.test(raw)) {
  throw new Error("Linux lifecycle report contains sensitive data or private paths");
}
const report = JSON.parse(raw);
for (const [key, value] of Object.entries(report)) {
  if (typeof value === "boolean" && value !== true) {
    throw new Error(`Linux lifecycle assertion failed: ${key}`);
  }
}
if (!report.baselineVersion || !report.updatedVersion
  || report.baselineVersion === report.updatedVersion) {
  throw new Error("Linux lifecycle report has invalid versions");
}
process.stdout.write(raw);
NODE

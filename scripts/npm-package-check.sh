#!/usr/bin/env bash
set -euo pipefail

unset \
  MEMORAX_CODE_HOME \
  CODEX_HOME \
  CLAUDE_CONFIG_DIR \
  CLAUDE_HOME

out_dir="${1:-dist/npm}"

usage() {
  cat <<USAGE
Usage: scripts/npm-package-check.sh [OUT_DIR]

Build the platform-neutral npm package staging directory, pack it into a .tgz file,
install it into a temporary npm global prefix, and verify installed commands.
USAGE
}

if [[ "${out_dir:-}" == "--help" || "${out_dir:-}" == "-h" ]]; then
  usage
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node scripts/check-docs.mjs
scripts/build-npm-packages.sh "$out_dir"
(
  unset GIT_INDEX_FILE
  make test-npm-package
)

package_version="$(node -e 'const fs = require("fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(pkg.version);' "$out_dir/memorax-code/package.json")"

python3 - <<'PY_STAGED_PACKAGE' "$out_dir/memorax-code" "packages/npm/memorax-code/shipped-docs.json"
import json
import sys
from pathlib import Path

package_root = Path(sys.argv[1])
shipped_docs = json.loads(Path(sys.argv[2]).read_text())
readme = (package_root / "README.md").read_text()
license_text = (package_root / "LICENSE").read_text()
package_manifest = json.loads((package_root / "package.json").read_text())
assert "npm install -g @memorax/memorax-code --foreground-scripts" in readme
assert license_text == Path("LICENSE").read_text()
assert package_manifest["name"] == "@memorax/memorax-code"
assert package_manifest["license"] == "MIT"
assert package_manifest.get("engines", {}).get("node") == ">=24"
assert "LICENSE" in package_manifest["files"]
expected_bins = {
    "memorax-code": "bin/memorax-code.mjs",
    "memorax-cli": "bin/memorax-cli.mjs",
    "memorax-code-backend": "bin/memorax-code-backend.mjs",
    "memorax-code-claude": "bin/memorax-code-claude.mjs",
    "memorax-code-codex": "bin/memorax-code-codex.mjs",
}
assert package_manifest.get("bin") == expected_bins, package_manifest.get("bin")
for relative in expected_bins.values():
    assert (package_root / relative).is_file(), relative
expected_library_dirs = {
    "memorax-code-adapter-common",
    "memorax-code-backend",
    "memorax-code-claude-adapter",
    "memorax-code-claude-marketplace",
    "memorax-code-codex-adapter",
    "memorax-code-opencode-adapter",
}
actual_library_dirs = {
    path.name
    for path in (package_root / "lib").iterdir()
    if path.is_dir()
}
assert actual_library_dirs == expected_library_dirs, actual_library_dirs
actual_docs = sorted(
    path.relative_to(package_root / "docs").as_posix()
    for path in (package_root / "docs").rglob("*.md")
    if path.is_file()
)
assert actual_docs == sorted(shipped_docs), actual_docs
memorax_defaults = (
    package_root
    / "lib"
    / "memorax-code-adapter-common"
    / "src"
    / "memorax-defaults.mjs"
).read_text()
assert 'MEMORAX_DEFAULT_BASE_URL = "https://platform.memorax.net"' in memorax_defaults
assert 'MEMORAX_ACCOUNT_URL = "https://platform.memorax.net/"' in memorax_defaults
assert 'MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE = "zh"' in memorax_defaults
for relative in [
    "bin/memorax-code-npm-preinstall.mjs",
    "lib/client-hook-runtime.mjs",
    "lib/resolve-claude-command.mjs",
    "lib/resolve-codex-command.mjs",
    "lib/vscode-extension-command.mjs",
    "lib/npm-invocation.mjs",
    "lib/windows-cli-invocation.mjs",
    "lib/memorax-code-adapter-common/src/backend-connection.mjs",
    "lib/memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
    "lib/memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs",
    "lib/memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
    "lib/memorax-code-adapter-common/src/memorax-defaults.mjs",
    "lib/memorax-code-adapter-common/src/runtime-record.mjs",
    "lib/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
    "lib/memorax-code-adapter-common/src/clients/claude-command.mjs",
    "lib/memorax-code-adapter-common/src/clients/codex-command.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-worker.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs",
    "lib/memorax-code-adapter-common/src/windows-cli-invocation.mjs",
    "lib/memorax-code-backend/dist/clients/codex/plugin-hooks.js",
    "lib/memorax-code-backend/dist/codex-adapter-lifecycle.js",
    "lib/memorax-code-backend/dist/windows-cli-invocation.js",
    "lib/memorax-code-backend/dist/memory/automatic-retrieval.js",
    "lib/memorax-code-backend/dist/memory/service.js",
    "lib/memorax-code-backend/dist/memory/turn-coordinator.js",
    "lib/memorax-code-backend/dist/clients/claude/memory-hook-runtime.js",
    "lib/memorax-code-backend/dist/clients/claude/transcript-turn.js",
    "lib/memorax-code-codex-adapter/assets/composer-icon.png",
    "lib/memorax-code-codex-adapter/assets/logo.png",
    "lib/memorax-code-codex-adapter/hooks/hooks.json",
    "lib/memorax-code-codex-adapter/hooks/runtime-hook.mjs",
    "lib/memorax-code-codex-adapter/hooks/runtime-shell.json",
    "lib/memorax-code-codex-adapter/runtime-hooks/memory-skill-reminder.mjs",
    "lib/memorax-code-codex-adapter/runtime-hooks/memory-writeback.mjs",
    "lib/memorax-code-codex-adapter/src/workspace-kind.mjs",
    "lib/memorax-code-codex-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-claude-adapter/hooks/hooks.json",
    "lib/memorax-code-claude-adapter/hooks/runtime-hook.mjs",
    "lib/memorax-code-claude-adapter/hooks/runtime-shell.json",
    "lib/memorax-code-claude-adapter/hooks/repo-memory-job.mjs",
    "lib/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs",
    "lib/memorax-code-claude-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/hooks.json",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-hook.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-shell.json",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/repo-memory-job.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/backend-connection.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/runtime-record.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-opencode-adapter/src/plugin.mjs",
    "lib/memorax-code-opencode-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-backend/dist/service-entrypoint.js",
    "lib/memorax-code-backend/dist/memorax-cli.js",
    "lib/memorax-code-backend/dist/jsonl-append.js",
]:
    assert (package_root / relative).exists(), relative
manifest = json.loads((package_root / "lib" / "memorax-code-codex-adapter" / ".codex-plugin" / "plugin.json").read_text())
claude_manifest = json.loads((package_root / "lib" / "memorax-code-claude-adapter" / ".claude-plugin" / "plugin.json").read_text())
marketplace_claude_manifest = json.loads((package_root / "lib" / "memorax-code-claude-marketplace" / "plugins" / "memorax-code-claude-adapter" / ".claude-plugin" / "plugin.json").read_text())
codex_shell = json.loads((package_root / "lib" / "memorax-code-codex-adapter" / "hooks" / "runtime-shell.json").read_text())
claude_shell = json.loads((package_root / "lib" / "memorax-code-claude-adapter" / "hooks" / "runtime-shell.json").read_text())
assert manifest["version"] == codex_shell["shellVersion"]
assert claude_manifest["version"] == claude_shell["shellVersion"]
assert marketplace_claude_manifest["version"] == claude_shell["shellVersion"]
claude_hooks = (package_root / "lib" / "memorax-code-claude-adapter" / "hooks" / "hooks.json").read_text()
assert "runtime-hook.mjs" in claude_hooks
assert "memory-turn" in claude_hooks
assert "memory-cli-session" in claude_hooks
assert "ensure-backend" in claude_hooks
generated_python_artifacts = sorted(
    str(path.relative_to(package_root))
    for path in package_root.rglob("*")
    if path.name == "__pycache__" or (path.is_file() and path.suffix in {".pyc", ".pyo"})
)
assert not generated_python_artifacts, generated_python_artifacts
symlinks = sorted(
    str(path.relative_to(package_root))
    for path in package_root.rglob("*")
    if path.is_symlink()
)
assert not symlinks, symlinks
PY_STAGED_PACKAGE

tarball_dir="$out_dir/tarballs"
mkdir -p "$tarball_dir"

main_pack_json="$out_dir/main-pack.json"
npm pack "$out_dir/memorax-code" --pack-destination "$tarball_dir" --json > "$main_pack_json"
node scripts/validate-npm-pack-json.mjs "$main_pack_json"
main_tgz="$tarball_dir/$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(value[0].filename)' "$main_pack_json")"

prefix=""
home_dir=""
tarball_extract=""
codex_smoke_started=0
package_install_started=0
package_install_port=""
cleanup() {
  if [[ "$package_install_started" == "1" \
    && -n "$package_install_port" \
    && -n "$prefix" \
    && -n "$home_dir" \
    && -x "$prefix/bin/memorax-code" ]]; then
    HOME="$home_dir" \
    MEMORAX_CODE_HOME="$home_dir/.memorax-code" \
    MEMORAX_CODE_BACKEND_PORT="$package_install_port" \
      "$prefix/bin/memorax-code" stop \
        --home "$home_dir/.memorax-code" \
        --port "$package_install_port" \
        --clients none \
        --json >/dev/null 2>&1 || true
  fi
  if [[ "$codex_smoke_started" == "1" \
    && -n "${codex_home:-}" \
    && -n "${codex_memorax_code_home:-}" \
    && -n "${codex_port:-}" \
    && -n "$prefix" \
    && -x "$prefix/bin/memorax-code" ]]; then
    CODEX_HOME="$codex_home" \
    MEMORAX_CODE_BACKEND_PORT="$codex_port" \
      "$prefix/bin/memorax-code" stop \
        --home "$codex_memorax_code_home" \
        --port "$codex_port" \
        --codex-home "$codex_home" \
        --clients codex \
        --json >/dev/null 2>&1 || true
  fi
  rm -rf "${prefix:-}" "${home_dir:-}" "${tarball_extract:-}"
}
trap cleanup EXIT

prefix="$(mktemp -d)"
home_dir="$(mktemp -d)"
tarball_extract="$(mktemp -d)"

tar -xzf "$main_tgz" -C "$tarball_extract"
if find "$tarball_extract" -type l -print -quit | grep -q .; then
  echo "npm-package-check: packed tarball contains a symbolic link" >&2
  exit 1
fi

export HOME="$home_dir"
export MEMORAX_CODE_HOME="$home_dir/.memorax-code"
export CODEX_HOME="$home_dir/.codex-memorax-code-package-check"
export CLAUDE_CONFIG_DIR="$home_dir/.claude-memorax-code-package-check"
export CLAUDE_HOME="$CLAUDE_CONFIG_DIR"
package_install_port="$(node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')"
export MEMORAX_CODE_BACKEND_PORT="$package_install_port"

package_install_started=1
npm install -g --prefix "$prefix" "$main_tgz" --silent

package_install_root="$prefix/lib/node_modules/@memorax/memorax-code"
cmp LICENSE "$package_install_root/LICENSE"
python3 - <<'PY_INSTALLED_DOCS' "$package_install_root/docs" "packages/npm/memorax-code/shipped-docs.json"
import json
import sys
from pathlib import Path

docs_root = Path(sys.argv[1])
expected = sorted(json.loads(Path(sys.argv[2]).read_text()))
actual = sorted(
    path.relative_to(docs_root).as_posix()
    for path in docs_root.rglob("*.md")
    if path.is_file()
)
assert actual == expected, actual
PY_INSTALLED_DOCS

for relative in \
  lib/client-hook-runtime.mjs \
  lib/resolve-claude-command.mjs \
  lib/resolve-codex-command.mjs \
  lib/vscode-extension-command.mjs \
  lib/npm-invocation.mjs \
  lib/windows-cli-invocation.mjs \
  lib/memorax-code-adapter-common/src/backend-connection.mjs \
  lib/memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs \
  lib/memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs \
  lib/memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs \
  lib/memorax-code-adapter-common/src/memorax-defaults.mjs \
  lib/memorax-code-adapter-common/src/runtime-record.mjs \
  lib/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs \
  lib/memorax-code-adapter-common/src/clients/claude-command.mjs \
  lib/memorax-code-adapter-common/src/clients/codex-command.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-worker.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs \
  lib/memorax-code-adapter-common/src/windows-cli-invocation.mjs \
  lib/memorax-code-backend/dist/clients/codex/plugin-hooks.js \
  lib/memorax-code-backend/dist/codex-adapter-lifecycle.js \
  lib/memorax-code-backend/dist/windows-cli-invocation.js \
  lib/memorax-code-backend/dist/memory/service.js \
  lib/memorax-code-codex-adapter/hooks/runtime-hook.mjs \
  lib/memorax-code-codex-adapter/hooks/runtime-shell.json \
  lib/memorax-code-codex-adapter/runtime-hooks/memory-writeback.mjs \
  lib/memorax-code-claude-adapter/hooks/runtime-hook.mjs \
  lib/memorax-code-claude-adapter/hooks/runtime-shell.json \
  lib/memorax-code-claude-adapter/hooks/repo-memory-job.mjs \
  lib/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-hook.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-shell.json \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/repo-memory-job.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/backend-connection.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/runtime-record.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/skills/memorax-code/SKILL.md \
  lib/memorax-code-opencode-adapter/src/plugin.mjs \
  lib/memorax-code-opencode-adapter/skills/memorax-code/SKILL.md
do
  test -f "$package_install_root/$relative"
done

python3 - <<'PY_POSTINSTALL' "$home_dir" "$CODEX_HOME" "$package_version"
import json
import sys
from pathlib import Path

home = Path(sys.argv[1])
codex_home = Path(sys.argv[2])
manifest = codex_home / ".memorax-code" / "plugins" / "memorax-code-codex-adapter" / ".codex-plugin" / "plugin.json"
manifest_data = json.loads(manifest.read_text())
shell = json.loads((manifest.parent.parent / "hooks" / "runtime-shell.json").read_text())
assert manifest_data["name"] == "memorax-code-codex-adapter"
assert manifest_data["version"] == shell["shellVersion"]
assert not (codex_home / "plugins" / "memorax-code-codex-adapter").exists()
marketplace = json.loads((home / ".agents" / "plugins" / "marketplace.json").read_text())
assert marketplace["name"] == "personal"
assert marketplace["plugins"][0]["source"]["path"] == "./.codex-memorax-code-package-check/.memorax-code/plugins/memorax-code-codex-adapter"
assert marketplace["plugins"][0]["source"]["source"] == "local"
memorax_code_config = home / ".memorax-code" / "config.toml"
config_text = memorax_code_config.read_text()
config_sections = {
    line.strip()[1:-1]
    for line in config_text.splitlines()
    if line.strip().startswith("[") and line.strip().endswith("]")
}
assert config_sections == {
    "clients",
    "memorax",
    "memory.add",
    "memory.retrieval",
    "memory.repo_update",
    "memory.skill_reminder",
    "memory.writeback",
    "trace.claude",
    "trace.codex",
}
assert 'output_language = "zh"' in config_text
assert memorax_code_config.stat().st_mode & 0o777 == 0o600
hook_runtime_root = home / ".memorax-code" / "runtime" / "client-hooks"
current_path = hook_runtime_root / "current.json"
current = json.loads(current_path.read_text())
assert current["version"] == 1
assert current["runtimeAbi"] == 1
generation = hook_runtime_root / "generations" / current["generationId"]
generation_manifest = json.loads((generation / "generation.json").read_text())
assert generation_manifest["generationId"] == current["generationId"]
assert generation_manifest["contentDigest"] == current["contentDigest"]
assert (generation / "lib" / "memorax-code-codex-adapter" / "runtime-hooks" / "memory-writeback.mjs").exists()
assert (generation / "lib" / "memorax-code-claude-adapter" / "runtime-hooks" / "memory-turn.mjs").exists()
assert current_path.stat().st_mode & 0o777 == 0o600
PY_POSTINSTALL

"$prefix/bin/memorax-code" stop \
  --home "$MEMORAX_CODE_HOME" \
  --port "$package_install_port" \
  --clients none \
  --json >/dev/null
package_install_started=0

skip_prefix="$(mktemp -d)"
skip_home="$(mktemp -d)"
MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL=1 \
HOME="$skip_home" \
MEMORAX_CODE_HOME="$skip_home/.memorax-code" \
CODEX_HOME="$skip_home/.codex-skip" \
CLAUDE_CONFIG_DIR="$skip_home/.claude" \
CLAUDE_HOME="$skip_home/.claude" \
  npm install -g --prefix "$skip_prefix" "$main_tgz" --silent
if [[ -e "$skip_home/.agents/plugins/marketplace.json" || -e "$skip_home/.codex-skip/.memorax-code/plugins/memorax-code-codex-adapter" || -e "$skip_home/.codex-skip/plugins/memorax-code-codex-adapter" ]]; then
  echo "npm-package-check: postinstall skip still registered Codex plugin" >&2
  exit 1
fi
HOME="$skip_home" \
MEMORAX_CODE_HOME="$skip_home/.memorax-code" \
MEMORAX_CODE_BACKEND_PORT="$package_install_port" \
  "$skip_prefix/bin/memorax-code" stop \
    --home "$skip_home/.memorax-code" \
    --port "$package_install_port" \
    --clients none \
    --json >/dev/null 2>&1 || true
rm -rf "$skip_prefix" "$skip_home"

"$prefix/bin/memorax-code" --help >/dev/null
test "$("$prefix/bin/memorax-code" --version)" = "memorax-code $package_version"
if [[ "$package_version" == *-* ]]; then
  default_update_channel="preview"
else
  default_update_channel="latest"
fi
test "$("$prefix/bin/memorax-code" update --dry-run)" = "npm install -g @memorax/memorax-code@${default_update_channel} --foreground-scripts"
"$prefix/bin/memorax-code" update --preview --dry-run | grep -qx 'npm install -g @memorax/memorax-code@preview --foreground-scripts'
"$prefix/bin/memorax-code" update --latest --dry-run | grep -qx 'npm install -g @memorax/memorax-code@latest --foreground-scripts'
test "$("$prefix/bin/memorax-code" update --force --dry-run)" = "npm install -g @memorax/memorax-code@${default_update_channel} --force --foreground-scripts"
"$prefix/bin/memorax-code" update --latest --force --dry-run | grep -qx 'npm install -g @memorax/memorax-code@latest --force --foreground-scripts'
if "$prefix/bin/memorax-code" update --preview --latest --dry-run >"$home_dir/memorax-code-update-conflict.txt" 2>&1; then
  echo "npm-package-check: conflicting update channels unexpectedly succeeded" >&2
  exit 1
fi
grep -q -- '--preview and --latest cannot be used together' "$home_dir/memorax-code-update-conflict.txt"
update_cwd_root="$home_dir/memorax-code-update-cwd"
mkdir -p "$update_cwd_root/gone" "$update_cwd_root/bin"
cat > "$update_cwd_root/bin/npm" <<'EOF_NPM_STUB'
#!/usr/bin/env bash
printf '%s\n' "$PWD" > "$MEMORAX_CODE_UPDATE_TEST_CWD_FILE"
printf '%s\n' "$*" > "$MEMORAX_CODE_UPDATE_TEST_ARGS_FILE"
printf '%s\n' "${MEMORAX_CODE_NPM_POSTINSTALL_UPDATE:-}" > "$MEMORAX_CODE_UPDATE_TEST_MODE_FILE"
printf '%s\n' "${MEMORAX_CODE_HOME:-}" > "$MEMORAX_CODE_UPDATE_TEST_HOME_FILE"
EOF_NPM_STUB
chmod +x "$update_cwd_root/bin/npm"
update_memorax_code_home="$update_cwd_root/custom memorax-code home"
(
  cd "$update_cwd_root/gone"
  rmdir "$update_cwd_root/gone"
  PATH="$update_cwd_root/bin:$PATH" \
  MEMORAX_CODE_HOME="$update_cwd_root/wrong-home" \
  MEMORAX_CODE_UPDATE_TEST_CWD_FILE="$update_cwd_root/cwd.txt" \
  MEMORAX_CODE_UPDATE_TEST_ARGS_FILE="$update_cwd_root/args.txt" \
  MEMORAX_CODE_UPDATE_TEST_MODE_FILE="$update_cwd_root/mode.txt" \
  MEMORAX_CODE_UPDATE_TEST_HOME_FILE="$update_cwd_root/home.txt" \
    "$prefix/bin/memorax-code" update --home "$update_memorax_code_home" >/dev/null
)
grep -qx "$home_dir" "$update_cwd_root/cwd.txt"
grep -Fqx "install -g @memorax/memorax-code@${default_update_channel} --foreground-scripts" "$update_cwd_root/args.txt"
grep -qx '1' "$update_cwd_root/mode.txt"
grep -Fqx "$update_memorax_code_home" "$update_cwd_root/home.txt"
"$prefix/bin/memorax-code-backend" --help >/dev/null
"$prefix/bin/memorax-cli" --help >/dev/null
test "$("$prefix/bin/memorax-cli" --version)" = "memorax-cli $package_version"
MEMORAX_CODE_HOME="$home_dir/.memorax-code-cli-check" \
MEMORAX_CODE_MEMORAX_ENDPOINT="https://platform.memorax.net" \
MEMORAX_CODE_MEMORAX_API_KEY="package-check-key" \
MEMORAX_CODE_MEMORAX_USER_ID="package-check-user" \
  "$prefix/bin/memorax-cli" status --json --config-only > "$home_dir/memorax-cli-status.json"
node -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (report.ok !== true || report.action !== "memory.status" || report.provider !== "memory.memorax") process.exit(1);
' "$home_dir/memorax-cli-status.json"
"$prefix/bin/memorax-code-codex" --help >/dev/null
"$prefix/bin/memorax-code-claude" --help >/dev/null

claude_home="$home_dir/.claude-memorax-code-package-check"
claude_memorax_code_home="$home_dir/.memorax-code-claude-package-check"
mkdir -p "$claude_home" "$claude_memorax_code_home"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "memorax-code-package-check-key" } }, null, 2) + "\n")' "$claude_home/settings.json"
CLAUDE_CONFIG_DIR="$claude_home" \
MEMORAX_CODE_BACKEND_PORT=18787 \
  "$prefix/bin/memorax-code" start \
    --home "$claude_memorax_code_home" \
    --clients claude \
    --json > "$home_dir/claude-start.json"

CLAUDE_CONFIG_DIR="$claude_home" \
MEMORAX_CODE_BACKEND_PORT=18787 \
  "$prefix/bin/memorax-code-claude" status \
    --memorax-code-home "$claude_memorax_code_home" \
    --claude-home "$claude_home" \
    --json > "$home_dir/claude-status.json"

python3 - <<'PY_CLAUDE' "$home_dir" "$claude_home" "$claude_memorax_code_home"
import json
import sys
from pathlib import Path

home = Path(sys.argv[1])
claude_home = Path(sys.argv[2])
memorax_code_home = Path(sys.argv[3])
start = json.loads((home / "claude-start.json").read_text())
assert start["ok"] is True
assert "codexAdapter" not in start
assert start["claudeAdapter"]["installed"] is True
assert start["claudeAdapter"]["enabled"] is True
assert start["claudeAdapter"]["integration"] == "hooks"
status = json.loads((home / "claude-status.json").read_text())
assert status["installed"] is True
assert status["enabled"] is True
assert status["integration"] == "hooks"
assert "memorax-code-package-check-key" not in json.dumps(status)
assert status["claudeSkills"]["ok"] is True, status["claudeSkills"]
assert status["claudeSkills"]["status"] == "plugin-managed", status["claudeSkills"]
assert status["claudeSkills"]["counts"]["total"] == 1, status["claudeSkills"]
assert status["claudeSkills"]["counts"]["linked"] == 0, status["claudeSkills"]
settings = json.loads((claude_home / "settings.json").read_text())
assert settings["env"] == {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_API_KEY": "memorax-code-package-check-key",
}
plugin_states = list((memorax_code_home / "adapters" / "claude-code" / "plugins").glob("*.json"))
assert len(plugin_states) == 1, plugin_states
plugin_state = json.loads(plugin_states[0].read_text())
assert plugin_state["plugin"] == "memorax-code-claude-adapter@memorax-code-local"
assert plugin_state["marketplace"] == "memorax-code-local"
marketplace_path = Path(plugin_state["marketplacePath"])
assert marketplace_path.exists(), marketplace_path
assert marketplace_path.name == "memorax-code-claude-marketplace"
install_path = Path(plugin_state["installPath"])
assert install_path.exists(), install_path
assert (install_path / "hooks" / "hooks.json").exists()
assert (install_path / "skills" / "memorax-code" / "SKILL.md").exists()
assert (install_path / "hooks" / "runtime-hook.mjs").exists()
assert (install_path / "hooks" / "runtime-shell.json").exists()
assert (install_path / "runtime-hooks" / "memory-turn.mjs").exists()
assert (install_path / "hooks" / "repo-memory-job.mjs").exists()
state = json.loads((memorax_code_home / "adapters" / "claude-code" / "state.json").read_text())
assert state["version"] == 1
assert state["runtime"] == "claude-code"
assert state["integration"] == "hooks"
assert state["enabled"] is True
assert state["backendUrl"] == "http://127.0.0.1:18787"
assert state["claudeSkillDelivery"] == "plugin"
assert Path(state["claudePluginSkillsRoot"]) == install_path / "skills"
PY_CLAUDE

CLAUDE_CONFIG_DIR="$claude_home" MEMORAX_CODE_BACKEND_PORT=18787 "$prefix/bin/memorax-code" stop --home "$claude_memorax_code_home" --clients claude --json >/dev/null || true

codex_home="$home_dir/.codex-memorax-code-package-check"
CODEX_HOME="$codex_home" "$prefix/bin/memorax-code" codex-plugin install --json > "$home_dir/codex-plugin-install.json"
python3 - <<'PY_CHECK' "$home_dir" "$codex_home" "$package_version"
import json
import sys
from pathlib import Path

home = Path(sys.argv[1])
codex_home = Path(sys.argv[2])
report = json.loads((home / "codex-plugin-install.json").read_text())
assert report["ok"] is True
assert report["codexHome"] == str(codex_home)
manifest = codex_home / ".memorax-code" / "plugins" / "memorax-code-codex-adapter" / ".codex-plugin" / "plugin.json"
manifest_data = json.loads(manifest.read_text())
shell = json.loads((manifest.parent.parent / "hooks" / "runtime-shell.json").read_text())
assert manifest_data["name"] == "memorax-code-codex-adapter"
assert manifest_data["version"] == shell["shellVersion"], manifest_data
skills_root = manifest.parent.parent / "skills"
skill_names = sorted(path.name for path in skills_root.iterdir() if path.is_dir())
assert skill_names == ["memorax-code"], skill_names
assert (skills_root / "memorax-code" / "SKILL.md").exists()
assert not (codex_home / "plugins" / "memorax-code-codex-adapter").exists()
marketplace = json.loads((home / ".agents" / "plugins" / "marketplace.json").read_text())
assert marketplace["name"] == "personal"
assert marketplace["plugins"][0]["source"]["path"] == "./.codex-memorax-code-package-check/.memorax-code/plugins/memorax-code-codex-adapter"
assert marketplace["plugins"][0]["source"]["source"] == "local"
PY_CHECK

codex_staged_plugin_root="$codex_home/.memorax-code/plugins/memorax-code-codex-adapter"
codex_active_plugin_root="$codex_home/plugins/cache/memorax-code/memorax-code-codex-adapter/package-smoke"
mkdir -p "$(dirname "$codex_active_plugin_root")"
cp -R "$codex_staged_plugin_root" "$codex_active_plugin_root"

codex_memorax_code_home="$home_dir/.memorax-code-codex-hooks-package-check"
codex_port="$(python3 - <<'PY_FREE_PORT'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.bind(("127.0.0.1", 0))
    print(probe.getsockname()[1])
PY_FREE_PORT
)"
python3 - <<'PY_CODEX_CONFIG' "$codex_home"
import sys
from pathlib import Path

codex_home = Path(sys.argv[1])
codex_home.mkdir(parents=True, exist_ok=True)
config_path = codex_home / "config.toml"
config_path.write_text("\n".join([
    'model_provider = "package-smoke"',
    'model = "package-smoke-model"',
    '',
    '[model_providers.package-smoke]',
    'name = "Package smoke"',
    'base_url = "https://provider.example/v1"',
    'wire_api = "responses"',
    '',
]))
config_path.chmod(0o600)
PY_CODEX_CONFIG

codex_smoke_started=1
for attempt in first second; do
  CODEX_HOME="$codex_home" \
  MEMORAX_CODE_BACKEND_PORT="$codex_port" \
    "$prefix/bin/memorax-code" start \
      --home "$codex_memorax_code_home" \
      --port "$codex_port" \
      --codex-home "$codex_home" \
      --clients codex \
      --json > "$home_dir/codex-$attempt-start.json"
done

MEMORAX_CODE_NPM_POSTINSTALL_UPDATE=1 \
MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL=1 \
MEMORAX_CODE_HOME="$codex_memorax_code_home" \
CODEX_HOME="$codex_home" \
MEMORAX_CODE_BACKEND_PORT="$codex_port" \
  npm install -g --prefix "$prefix" "$main_tgz" --force --silent

python3 - <<'PY_CODEX_ACTIVE' "$home_dir" "$codex_home" "$codex_memorax_code_home"
import json
import sys
from pathlib import Path

home = Path(sys.argv[1])
codex_home = Path(sys.argv[2])
memorax_code_home = Path(sys.argv[3])
for attempt in ["first", "second"]:
    report = json.loads((home / f"codex-{attempt}-start.json").read_text())
    assert report["ok"] is True, report
    assert report["backend"]["ok"] is True, report
    assert report["codexAdapter"]["ok"] is True, report
    assert report["codexAdapter"]["enabled"] is True, report
    assert Path(report["backend"]["state"]["logPath"]) == memorax_code_home / "runtime" / "backend" / "backend.log"

assert (memorax_code_home / "runtime" / "backend" / "backend.pid.json").exists()

config_text = (codex_home / "config.toml").read_text()
expected = "\n".join([
    'model_provider = "package-smoke"',
    'model = "package-smoke-model"',
    '',
    '[model_providers.package-smoke]',
    'name = "Package smoke"',
    'base_url = "https://provider.example/v1"',
    'wire_api = "responses"',
    '',
])
assert config_text == expected
state = json.loads((memorax_code_home / "adapters" / "codex" / "state.json").read_text())
assert state["version"] == 1
assert state["runtime"] == "codex"
assert state["integration"] == "hooks"
assert state["enabled"] is True
assert state["backendUrl"].startswith("http://127.0.0.1:")
PY_CODEX_ACTIVE

CODEX_HOME="$codex_home" \
MEMORAX_CODE_BACKEND_PORT="$codex_port" \
  "$prefix/bin/memorax-code" stop \
    --home "$codex_memorax_code_home" \
    --port "$codex_port" \
    --codex-home "$codex_home" \
    --clients codex \
    --json >/dev/null
codex_smoke_started=0

python3 - <<'PY_CODEX_UNCHANGED' "$codex_home"
import sys
from pathlib import Path

codex_home = Path(sys.argv[1])
expected = "\n".join([
    'model_provider = "package-smoke"',
    'model = "package-smoke-model"',
    '',
    '[model_providers.package-smoke]',
    'name = "Package smoke"',
    'base_url = "https://provider.example/v1"',
    'wire_api = "responses"',
    '',
])
assert (codex_home / "config.toml").read_text() == expected
PY_CODEX_UNCHANGED

printf 'npm-package-check: completed\n'

#!/usr/bin/env bash
set -euo pipefail

unset \
  MEMORAX_CODE_HOME \
  CODEX_HOME \
  DSH_HOME \
  CLAUDE_CONFIG_DIR \
  CLAUDE_HOME \
  OPENCODE_CONFIG_DIR

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
  isolated_test_home="$(mktemp -d)"
  trap 'rm -rf "$isolated_test_home"' EXIT
  HOME="$isolated_test_home" \
  MEMORAX_CODE_HOME="$isolated_test_home/.memorax-code" \
  CODEX_HOME="$isolated_test_home/.codex" \
  DSH_HOME="$isolated_test_home/.dsh" \
  CLAUDE_CONFIG_DIR="$isolated_test_home/.claude" \
  CLAUDE_HOME="$isolated_test_home/.claude" \
    make test-npm-package
)

# Keep the live registry from replacing the staged future release during smoke tests.
export MEMORAX_CODE_AUTO_UPDATE=false

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
assert "npm install -g @memorax/memorax-code" in readme
assert "```bash\nmemorax-code setup --existing-account\n```" in readme
assert "```bash\nmemorax-code setup\n```" in readme
assert "--foreground-scripts" not in readme
assert license_text == Path("LICENSE").read_text()
assert package_manifest["name"] == "@memorax/memorax-code"
assert package_manifest["license"] == "MIT"
assert package_manifest.get("engines", {}).get("node") == ">=20"
assert "LICENSE" in package_manifest["files"]
expected_bins = {
    "memorax-code": "bin/memorax-code.mjs",
    "memorax-cli": "bin/memorax-cli.mjs",
    "memorax-code-backend": "bin/memorax-code-backend.mjs",
    "memorax-code-claude": "bin/memorax-code-claude.mjs",
    "memorax-code-codex": "bin/memorax-code-codex.mjs",
    "memorax-code-opencode": "bin/memorax-code-opencode.mjs",
    "memorax-code-codebuddy": "bin/memorax-code-codebuddy.mjs",
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
    "memorax-code-dsh-adapter",
    "memorax-code-opencode-adapter",
    "memorax-code-codebuddy-adapter",
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
    "bin/memorax-code-plugin-postinstall.mjs",
    "bin/memorax-code-setup.mjs",
    "lib/client-hook-runtime.mjs",
    "lib/automatic-update.mjs",
    "lib/dsh-plugin-install.mjs",
    "lib/resolve-claude-command.mjs",
    "lib/resolve-codex-command.mjs",
    "lib/resolve-codebuddy-command.mjs",
    "lib/vscode-extension-command.mjs",
    "lib/npm-invocation.mjs",
    "lib/package-transition.mjs",
    "lib/setup-memory-preferences.mjs",
    "lib/setup-reconcile.mjs",
    "lib/trial-setup.mjs",
    "lib/windows-cli-invocation.mjs",
    "lib/windows-user-path.mjs",
    "lib/memorax-code-adapter-common/src/backend-connection.mjs",
    "lib/memorax-code-adapter-common/src/config-utils.mjs",
    "lib/memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
    "lib/memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs",
    "lib/memorax-code-adapter-common/src/clients/codebuddy-command.mjs",
    "lib/memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
    "lib/memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs",
    "lib/memorax-code-adapter-common/src/memorax-defaults.mjs",
    "lib/memorax-code-adapter-common/src/runtime-record.mjs",
    "lib/memorax-code-adapter-common/src/setup-completion.mjs",
    "lib/memorax-code-adapter-common/src/automatic-update-state.mjs",
    "lib/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
    "lib/memorax-code-adapter-common/src/clients/claude-command.mjs",
    "lib/memorax-code-adapter-common/src/clients/codex-command.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-worker.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs",
    "lib/memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy.mjs",
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
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/setup-completion.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/automatic-update-state.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-dsh-adapter/package.json",
    "lib/memorax-code-dsh-adapter/cordis.patch.yml",
    "lib/memorax-code-dsh-adapter/src/index.mjs",
    "lib/memorax-code-dsh-adapter/src/backend-client.mjs",
    "lib/memorax-code-dsh-adapter/src/dsh-message.mjs",
    "lib/memorax-code-dsh-adapter/src/dsh-version.mjs",
    "lib/memorax-code-dsh-adapter/src/http-client.mjs",
    "lib/memorax-code-dsh-adapter/src/personal-context-worker.mjs",
    "lib/memorax-code-dsh-adapter/src/personal-context.mjs",
    "lib/memorax-code-dsh-adapter/src/plugin.mjs",
    "lib/memorax-code-dsh-adapter/src/profile-lifecycle.mjs",
    "lib/memorax-code-dsh-adapter/src/protocol.mjs",
    "lib/memorax-code-dsh-adapter/src/runtime-state.mjs",
    "lib/memorax-code-dsh-adapter/hooks/repo-memory-job.mjs",
    "lib/memorax-code-dsh-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-opencode-adapter/src/plugin.mjs",
    "lib/memorax-code-opencode-adapter/src/plugin-install.mjs",
    "lib/memorax-code-opencode-adapter/src/cli.mjs",
    "lib/memorax-code-opencode-adapter/src/repo-memory-server-runner.mjs",
    "lib/memorax-code-opencode-adapter/hooks/repo-memory-job.mjs",
    "lib/memorax-code-opencode-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-codebuddy-adapter/package.json",
    "lib/memorax-code-codebuddy-adapter/.codebuddy-plugin/plugin.json",
    "lib/memorax-code-codebuddy-adapter/hooks/hooks.json",
    "lib/memorax-code-codebuddy-adapter/hooks/runtime-hook.mjs",
    "lib/memorax-code-codebuddy-adapter/hooks/common-runtime.mjs",
    "lib/memorax-code-codebuddy-adapter/hooks/repo-memory-job.mjs",
    "lib/memorax-code-codebuddy-adapter/skills/memorax-code/SKILL.md",
    "lib/memorax-code-codebuddy-adapter/skills/memorax-code/references/memorax-search.md",
    "lib/memorax-code-codebuddy-adapter/skills/memorax-code/references/memorax-add.md",
    "lib/memorax-code-codebuddy-adapter/src/config.mjs",
    "lib/memorax-code-codebuddy-adapter/src/hook-manifest.mjs",
    "lib/memorax-code-codebuddy-adapter/src/runtime-observation.mjs",
    "lib/memorax-code-codebuddy-adapter/src/cli.mjs",
    "lib/memorax-code-backend/dist/service-entrypoint.js",
    "lib/memorax-code-backend/dist/memorax-cli.js",
    "lib/memorax-code-backend/dist/jsonl-append.js",
]:
    assert (package_root / relative).exists(), relative
manifest = json.loads((package_root / "lib" / "memorax-code-codex-adapter" / ".codex-plugin" / "plugin.json").read_text())
codebuddy_manifest = json.loads((package_root / "lib" / "memorax-code-codebuddy-adapter" / ".codebuddy-plugin" / "plugin.json").read_text())
assert codebuddy_manifest["skills"] == ["./skills/memorax-code"]
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
dsh_skill = package_root / "lib" / "memorax-code-dsh-adapter" / "skills" / "memorax-code" / "SKILL.md"
codex_skill = package_root / "lib" / "memorax-code-codex-adapter" / "skills" / "memorax-code" / "SKILL.md"
assert dsh_skill.read_bytes() == codex_skill.read_bytes()
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
claude_smoke_started=0
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
  if [[ "$claude_smoke_started" == "1" \
    && -n "${claude_home:-}" \
    && -n "${claude_memorax_code_home:-}" \
    && -n "${claude_port:-}" \
    && -n "$prefix" \
    && -x "$prefix/bin/memorax-code" ]]; then
    CLAUDE_CONFIG_DIR="$claude_home" \
    MEMORAX_CODE_BACKEND_PORT="$claude_port" \
      "$prefix/bin/memorax-code" stop \
        --home "$claude_memorax_code_home" \
        --port "$claude_port" \
        --clients claude \
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
export DSH_HOME="$home_dir/.dsh-memorax-code-package-check"
export CLAUDE_CONFIG_DIR="$home_dir/.claude-memorax-code-package-check"
export CLAUDE_HOME="$CLAUDE_CONFIG_DIR"
export OPENCODE_CONFIG_DIR="$home_dir/.config/opencode-memorax-code-package-check"
package_install_port="$(node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')"
export MEMORAX_CODE_BACKEND_PORT="$package_install_port"

npm install -g --prefix "$prefix" "$main_tgz" --silent

for unexpected in \
  "$MEMORAX_CODE_HOME" \
  "$CODEX_HOME" \
  "$DSH_HOME" \
  "$CLAUDE_CONFIG_DIR" \
  "$OPENCODE_CONFIG_DIR" \
  "$MEMORAX_CODE_HOME/config.toml" \
  "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json" \
  "$MEMORAX_CODE_HOME/runtime/install/package-transition.json" \
  "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json" \
  "$HOME/.agents/plugins/marketplace.json" \
  "$CODEX_HOME/.memorax-code/plugins/memorax-code-codex-adapter"
do
  if [[ -e "$unexpected" ]]; then
    echo "npm-package-check: fresh package install created setup state: $unexpected" >&2
    exit 1
  fi
done

if "$prefix/bin/memorax-code" >"$home_dir/before-setup.stdout" 2>"$home_dir/before-setup.stderr"; then
  echo "npm-package-check: no-argument CLI unexpectedly accepted incomplete setup" >&2
  exit 1
fi
grep -Fq 'setup has not been completed' "$home_dir/before-setup.stderr"

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
  bin/memorax-code-npm-preinstall.mjs \
  bin/memorax-code-plugin-postinstall.mjs \
  bin/memorax-code-setup.mjs \
  lib/client-hook-runtime.mjs \
  lib/automatic-update.mjs \
  lib/dsh-plugin-install.mjs \
  lib/resolve-claude-command.mjs \
  lib/resolve-codex-command.mjs \
  lib/resolve-codebuddy-command.mjs \
  lib/vscode-extension-command.mjs \
  lib/npm-invocation.mjs \
  lib/package-transition.mjs \
  lib/setup-memory-preferences.mjs \
  lib/setup-reconcile.mjs \
  lib/trial-setup.mjs \
  lib/windows-cli-invocation.mjs \
  lib/windows-user-path.mjs \
  lib/memorax-code-adapter-common/src/backend-connection.mjs \
  lib/memorax-code-adapter-common/src/config-utils.mjs \
  lib/memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs \
  lib/memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs \
  lib/memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs \
  lib/memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs \
  lib/memorax-code-adapter-common/src/memorax-defaults.mjs \
  lib/memorax-code-adapter-common/src/runtime-record.mjs \
  lib/memorax-code-adapter-common/src/setup-completion.mjs \
  lib/memorax-code-adapter-common/src/automatic-update-state.mjs \
  lib/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs \
  lib/memorax-code-adapter-common/src/clients/claude-command.mjs \
  lib/memorax-code-adapter-common/src/clients/codex-command.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-job-worker.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs \
  lib/memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy.mjs \
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
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/setup-completion.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/automatic-update-state.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs \
  lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/skills/memorax-code/SKILL.md \
  lib/memorax-code-dsh-adapter/package.json \
  lib/memorax-code-dsh-adapter/cordis.patch.yml \
  lib/memorax-code-dsh-adapter/src/index.mjs \
  lib/memorax-code-dsh-adapter/src/backend-client.mjs \
  lib/memorax-code-dsh-adapter/src/dsh-message.mjs \
  lib/memorax-code-dsh-adapter/src/dsh-version.mjs \
  lib/memorax-code-dsh-adapter/src/http-client.mjs \
  lib/memorax-code-dsh-adapter/src/personal-context-worker.mjs \
  lib/memorax-code-dsh-adapter/src/personal-context.mjs \
  lib/memorax-code-dsh-adapter/src/plugin.mjs \
  lib/memorax-code-dsh-adapter/src/profile-lifecycle.mjs \
  lib/memorax-code-dsh-adapter/src/protocol.mjs \
  lib/memorax-code-dsh-adapter/src/runtime-state.mjs \
  lib/memorax-code-dsh-adapter/hooks/repo-memory-job.mjs \
  lib/memorax-code-dsh-adapter/skills/memorax-code/SKILL.md \
  lib/memorax-code-opencode-adapter/src/plugin.mjs \
  lib/memorax-code-opencode-adapter/src/plugin-install.mjs \
  lib/memorax-code-opencode-adapter/src/cli.mjs \
  lib/memorax-code-opencode-adapter/src/repo-memory-server-runner.mjs \
  lib/memorax-code-opencode-adapter/hooks/repo-memory-job.mjs \
  lib/memorax-code-opencode-adapter/skills/memorax-code/SKILL.md \
  lib/memorax-code-codebuddy-adapter/package.json \
  lib/memorax-code-codebuddy-adapter/.codebuddy-plugin/plugin.json \
  lib/memorax-code-codebuddy-adapter/hooks/hooks.json \
  lib/memorax-code-codebuddy-adapter/hooks/runtime-hook.mjs \
  lib/memorax-code-codebuddy-adapter/hooks/common-runtime.mjs \
  lib/memorax-code-codebuddy-adapter/hooks/repo-memory-job.mjs \
  lib/memorax-code-codebuddy-adapter/skills/memorax-code/SKILL.md \
  lib/memorax-code-codebuddy-adapter/skills/memorax-code/references/memorax-search.md \
  lib/memorax-code-codebuddy-adapter/skills/memorax-code/references/memorax-add.md \
  lib/memorax-code-codebuddy-adapter/src/config.mjs \
  lib/memorax-code-codebuddy-adapter/src/hook-manifest.mjs \
  lib/memorax-code-codebuddy-adapter/src/runtime-observation.mjs \
  lib/memorax-code-codebuddy-adapter/src/cli.mjs
do
  test -f "$package_install_root/$relative"
done

node --input-type=module -e '
  const lifecycle = await import(new URL("./lib/dsh-plugin-install.mjs", `file://${process.argv[1]}/`).href);
  for (const name of ["collectDshAdapterStatus", "discoverDshProfiles", "withDshPluginLifecycleLock"]) {
    if (typeof lifecycle[name] !== "function") throw new Error(`missing DSH lifecycle export: ${name}`);
  }
' "$package_install_root"

package_install_started=1
printf '%s\n' 'package-check-user' 'package-check-key' | \
  MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE=1 \
  MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL=1 \
  MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL=1 \
  MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL=1 \
  "$prefix/bin/memorax-code" setup --existing-account \
    >"$home_dir/setup.stdout" 2>"$home_dir/setup.stderr"
node --input-type=module - "$MEMORAX_CODE_HOME/config.toml" <<'NODE_DISABLE_DSH'
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const source = readFileSync(path, "utf8");
const updated = source.replace(/^dsh = true\b.*$/m, "dsh = false # Disabled for the stopped-reinstall package check.");
if (updated === source) throw new Error("package check could not disable DSH in generated config");
writeFileSync(path, updated, { mode: 0o600 });
NODE_DISABLE_DSH

python3 - <<'PY_SETUP' "$home_dir" "$CODEX_HOME" "$package_version"
import json
import sys
from pathlib import Path

home = Path(sys.argv[1])
codex_home = Path(sys.argv[2])
package_version = sys.argv[3]
assert not (codex_home / ".memorax-code" / "plugins" / "memorax-code-codex-adapter").exists()
assert not (codex_home / "plugins" / "memorax-code-codex-adapter").exists()
assert not (home / ".agents" / "plugins" / "marketplace.json").exists()
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
    "trace.codebuddy",
    "trace.dsh",
    "trace.opencode",
}
assert 'user_id = "package-check-user"' in config_text
assert 'api_key = "package-check-key"' in config_text
assert 'output_language = "' in config_text
assert "codex = false" in config_text
assert "claude = false" in config_text
assert "dsh = false" in config_text
assert "opencode = false" in config_text
assert memorax_code_config.stat().st_mode & 0o777 == 0o600
completion = json.loads((home / ".memorax-code" / "runtime" / "setup" / "setup-completion.json").read_text())
assert completion["version"] == 1
assert completion["state"] == "complete"
assert completion["completedByVersion"] == package_version
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
assert (home / ".memorax-code" / "runtime" / "backend" / "backend.pid.json").exists()
assert not (home / ".memorax-code" / "runtime" / "install" / "package-transition.json").exists()
PY_SETUP

cp "$MEMORAX_CODE_HOME/config.toml" "$home_dir/legacy-config-before-migration.toml"
rm "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json"
MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE=1 \
MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL=1 \
MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL=1 \
MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL=1 \
"$prefix/bin/memorax-code" >/dev/null 2>&1
cmp "$home_dir/legacy-config-before-migration.toml" "$MEMORAX_CODE_HOME/config.toml"
test -f "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json"

"$prefix/bin/memorax-code" >/dev/null

cp "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json" "$home_dir/setup-completion-before-update.json"
running_update_pid="$(node -e 'const fs = require("fs"); const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Number.isSafeInteger(state.pid) || state.pid <= 0) process.exit(1); process.stdout.write(String(state.pid));' "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json")"
npm install -g --prefix "$prefix" "$main_tgz" --silent
cmp "$home_dir/setup-completion-before-update.json" "$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json"
test -f "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json"
test ! -e "$MEMORAX_CODE_HOME/runtime/install/package-transition.json"
python3 - <<'PY_RUNNING_UPDATE' "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json" "$running_update_pid"
import json
import os
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text())
old_pid = int(sys.argv[2])
new_pid = state.get("pid")
assert isinstance(new_pid, int) and new_pid > 0, state
assert new_pid != old_pid, (old_pid, new_pid)
try:
    os.kill(old_pid, 0)
except ProcessLookupError:
    pass
else:
    raise AssertionError(f"pre-update Backend PID {old_pid} is still alive")
PY_RUNNING_UPDATE
"$prefix/bin/memorax-code" status \
  --home "$MEMORAX_CODE_HOME" \
  --port "$package_install_port" \
  --clients none \
  --json >/dev/null

stopped_reinstall_pid="$(node -e 'const fs = require("fs"); const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Number.isSafeInteger(state.pid) || state.pid <= 0) process.exit(1); process.stdout.write(String(state.pid));' "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json")"
"$prefix/bin/memorax-code" stop \
  --home "$MEMORAX_CODE_HOME" \
  --port "$package_install_port" \
  --clients none \
  --json >/dev/null
package_install_started=0
npm install -g --prefix "$prefix" "$main_tgz" --silent
test ! -e "$MEMORAX_CODE_HOME/runtime/backend/backend.pid.json"
test ! -e "$MEMORAX_CODE_HOME/runtime/install/package-transition.json"
python3 - <<'PY_STOPPED_REINSTALL' "$stopped_reinstall_pid"
import os
import sys

pid = int(sys.argv[1])
try:
    os.kill(pid, 0)
except ProcessLookupError:
    pass
else:
    raise AssertionError(f"stopped Backend PID {pid} is still alive after package reinstall")
PY_STOPPED_REINSTALL
node --input-type=module - "$package_install_port" <<'NODE_STOPPED_REINSTALL_PORT'
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const server = createServer();
server.once("error", (error) => {
  console.error(`npm-package-check: stopped reinstall left Backend port ${port} unavailable: ${error.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  server.close((error) => process.exit(error ? 1 : 0));
});
NODE_STOPPED_REINSTALL_PORT

"$prefix/bin/memorax-code" --help >/dev/null
test "$("$prefix/bin/memorax-code" --version)" = "memorax-code $package_version"
if [[ "$package_version" == *-* ]]; then
  default_update_channel="preview"
else
  default_update_channel="latest"
fi
test "$("$prefix/bin/memorax-code" update --dry-run)" = "npm install -g @memorax/memorax-code@${default_update_channel}"
"$prefix/bin/memorax-code" update --preview --dry-run | grep -qx 'npm install -g @memorax/memorax-code@preview'
"$prefix/bin/memorax-code" update --latest --dry-run | grep -qx 'npm install -g @memorax/memorax-code@latest'
test "$("$prefix/bin/memorax-code" update --force --dry-run)" = "npm install -g @memorax/memorax-code@${default_update_channel} --force"
"$prefix/bin/memorax-code" update --latest --force --dry-run | grep -qx 'npm install -g @memorax/memorax-code@latest --force'
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
  MEMORAX_CODE_UPDATE_TEST_HOME_FILE="$update_cwd_root/home.txt" \
    "$prefix/bin/memorax-code" update --home "$update_memorax_code_home" >/dev/null
)
grep -qx "$home_dir" "$update_cwd_root/cwd.txt"
grep -Fqx "install -g @memorax/memorax-code@${default_update_channel}" "$update_cwd_root/args.txt"
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
"$prefix/bin/memorax-code-opencode" --help >/dev/null

claude_home="$home_dir/.claude-memorax-code-package-check"
claude_memorax_code_home="$home_dir/.memorax-code-claude-package-check"
claude_port="$(python3 - <<'PY_FREE_PORT'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.bind(("127.0.0.1", 0))
    print(probe.getsockname()[1])
PY_FREE_PORT
)"
mkdir -p "$claude_home" "$claude_memorax_code_home"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "memorax-code-package-check-key" } }, null, 2) + "\n")' "$claude_home/settings.json"
claude_smoke_started=1
CLAUDE_CONFIG_DIR="$claude_home" \
MEMORAX_CODE_BACKEND_PORT="$claude_port" \
  "$prefix/bin/memorax-code" start \
    --home "$claude_memorax_code_home" \
    --port "$claude_port" \
    --clients claude \
    --json > "$home_dir/claude-start.json"

CLAUDE_CONFIG_DIR="$claude_home" \
MEMORAX_CODE_BACKEND_PORT="$claude_port" \
  "$prefix/bin/memorax-code-claude" status \
    --memorax-code-home "$claude_memorax_code_home" \
    --claude-home "$claude_home" \
    --json > "$home_dir/claude-status.json"

python3 - <<'PY_CLAUDE' "$home_dir" "$claude_home" "$claude_memorax_code_home" "$claude_port"
import json
import sys
from pathlib import Path

home = Path(sys.argv[1])
claude_home = Path(sys.argv[2])
memorax_code_home = Path(sys.argv[3])
claude_port = int(sys.argv[4])
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
assert state["backendUrl"] == f"http://127.0.0.1:{claude_port}"
assert state["claudeSkillDelivery"] == "plugin"
assert Path(state["claudePluginSkillsRoot"]) == install_path / "skills"
PY_CLAUDE

CLAUDE_CONFIG_DIR="$claude_home" MEMORAX_CODE_BACKEND_PORT="$claude_port" "$prefix/bin/memorax-code" stop --home "$claude_memorax_code_home" --port "$claude_port" --clients claude --json >/dev/null
claude_smoke_started=0

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
python3 - <<'PY_CODEX_CONFIG' "$codex_home" "$codex_memorax_code_home"
import sys
from pathlib import Path

codex_home = Path(sys.argv[1])
memorax_code_home = Path(sys.argv[2])
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

memorax_code_home.mkdir(parents=True, exist_ok=True)
memorax_code_config_path = memorax_code_home / "config.toml"
memorax_code_config_path.write_text("\n".join([
    "[clients]",
    "codex = true",
    "claude = false",
    "dsh = false",
    "opencode = false",
    "",
]))
memorax_code_config_path.chmod(0o600)
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

if [[ "${MEMORAX_CODE_DSH_E2E:-}" == "1" ]]; then
  MEMORAX_CODE_DSH_E2E_MEMORAX_TARBALL="$main_tgz" \
    node scripts/dsh-npm-package-e2e.mjs
fi

printf 'npm-package-check: completed\n'

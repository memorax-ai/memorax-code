#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-dist/npm}"
tag="${2:-${NPM_DIST_TAG:-}}"

usage() {
  cat <<USAGE
Usage: scripts/npm-publish-dry-run.sh [OUT_DIR] [TAG]

Build the platform-neutral npm package staging directory and run npm publish
--dry-run from the staged package. This does not upload anything.

TAG defaults to preview for prerelease builds and latest for stable builds.
USAGE
}

if [[ "${out_dir:-}" == "--help" || "${out_dir:-}" == "-h" || "${tag:-}" == "--help" || "${tag:-}" == "-h" ]]; then
  usage
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node scripts/sync-release-version.mjs --check
scripts/build-npm-packages.sh "$out_dir"

package_version="$(node -e 'const fs = require("fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(pkg.version);' "$out_dir/memorax-code/package.json")"
if [[ -z "$tag" ]]; then
  if [[ "$package_version" == *-* ]]; then
    tag="preview"
  else
    tag="latest"
  fi
fi
if [[ "$package_version" == *-* && "$tag" != "preview" ]]; then
  echo "prerelease npm packages must use the preview tag" >&2
  exit 2
fi
if [[ "$package_version" != *-* && "$tag" == "preview" ]]; then
  echo "the preview tag is only valid for prerelease npm packages" >&2
  exit 2
fi

(
  cd "$out_dir/memorax-code"
  npm publish --dry-run --access public --tag "$tag"
)

printf 'npm-publish-dry-run: completed\n'

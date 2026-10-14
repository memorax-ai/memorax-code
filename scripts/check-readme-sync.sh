#!/usr/bin/env bash
set -euo pipefail

base_ref="${README_SYNC_BASE_REF:-}"
head_ref="${README_SYNC_HEAD_REF:-HEAD}"
explicit_base=0

if [[ "$base_ref" =~ ^0+$ ]]; then
  base_ref=""
fi
if [[ -n "$base_ref" ]]; then
  explicit_base=1
fi

if [[ -z "$base_ref" ]]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1 \
      && git merge-base origin/main "$head_ref" >/dev/null 2>&1; then
    base_ref="origin/main"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    base_ref="HEAD~1"
  else
    echo "README sync check skipped: no base ref available."
    exit 0
  fi
fi

if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1 \
    || ! git rev-parse --verify "$head_ref" >/dev/null 2>&1; then
  echo "README sync check failed: invalid base/head ref ($base_ref, $head_ref)." >&2
  exit 2
fi

if ! git merge-base "$base_ref" "$head_ref" >/dev/null 2>&1; then
  if [[ "$explicit_base" -eq 1 ]]; then
    echo "README sync check failed: $base_ref and $head_ref have no merge base." >&2
    exit 2
  fi
  if git rev-parse --verify "${head_ref}~1" >/dev/null 2>&1; then
    base_ref="${head_ref}~1"
  else
    echo "README sync check skipped: no comparable base ref available."
    exit 0
  fi
fi

changed="$(git diff --name-only "$base_ref"..."$head_ref")"
english_changed=0
chinese_changed=0

if printf '%s\n' "$changed" | grep -qx 'README.md'; then
  english_changed=1
fi
if printf '%s\n' "$changed" | grep -qx 'README.zh.md'; then
  chinese_changed=1
fi

if [[ "$english_changed" -ne "$chinese_changed" ]]; then
  cat >&2 <<'MSG'
README language sync check failed.

README.md and README.zh.md must both be updated in the same change.
Update both language versions before merging, including language-specific edits.
MSG
  echo >&2
  echo "Changed files:" >&2
  printf '%s\n' "$changed" >&2
  exit 1
fi

echo "README language sync check passed."

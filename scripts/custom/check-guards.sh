#!/usr/bin/env bash
# Customization guards for the fork (run locally and in CI).
#
# 1. Every difference from upstream/master must be: an allowlisted upstream
#    file, or a new file under custom/, scripts/custom/, patches/,
#    .github/workflows/, or UPSTREAM.md.
# 2. Branding data must be valid and the transform must run (check mode).
# 3. patches/ must match the current patch stack when the directory exists.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/master}"
ALLOWLIST="$ROOT/custom/upstream-touch-allowlist.txt"

if ! git rev-parse --verify -q "$UPSTREAM_REF" >/dev/null; then
  echo "guard: upstream ref not found: $UPSTREAM_REF (run: git fetch upstream --tags)" >&2
  exit 2
fi

ALLOW_PATTERNS=()
while IFS= read -r line; do
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  ALLOW_PATTERNS+=("$line")
done < "$ALLOWLIST"

allowed() {
  local path="$1" pat
  case "$path" in
    custom/*|scripts/custom/*|patches/*|UPSTREAM.md|.github/workflows/*) return 0 ;;
  esac
  for pat in ${ALLOW_PATTERNS[@]+"${ALLOW_PATTERNS[@]}"}; do
    # shellcheck disable=SC2053
    [[ "$path" == $pat ]] && return 0
  done
  return 1
}

fail=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if ! allowed "$path"; then
    echo "guard: non-allowlisted upstream file changed: $path" >&2
    echo "       add it to custom/upstream-touch-allowlist.txt with a rationale, or move the change into custom/" >&2
    fail=1
  fi
done < <(git diff --name-only "$UPSTREAM_REF"...HEAD)

if [[ "$fail" -ne 0 ]]; then
  echo "guard: FAILED (upstream touch policy)" >&2
  exit 1
fi
echo "guard: upstream touch policy OK"

node "$ROOT/custom/branding/apply-brand.mjs" --root "$ROOT" --check
echo "guard: branding transform OK"

if [[ -d "$ROOT/patches" ]]; then
  bash "$ROOT/scripts/custom/regen-patches.sh" --check
  echo "guard: patch snapshot OK"
fi

echo "guard: PASS"

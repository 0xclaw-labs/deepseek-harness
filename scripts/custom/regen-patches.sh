#!/usr/bin/env bash
# Export the cumulative diff of allowlisted upstream files as a single,
# reviewable patch snapshot. The snapshot is NOT how upgrades are applied
# (upgrades merge upstream into custom/main); it exists so reviewers can see
# exactly which upstream lines we carry, and as a fallback if a merge conflicts.
#
# Usage: regen-patches.sh [--check|--write]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
MODE="${1:---check}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/master}"
OUT="$ROOT/patches"
ALLOWLIST="$ROOT/custom/upstream-touch-allowlist.txt"

if ! git rev-parse --verify -q "$UPSTREAM_REF" >/dev/null; then
  echo "regen-patches: upstream ref not found: $UPSTREAM_REF" >&2
  exit 2
fi

PATHS=()
while IFS= read -r line; do
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  PATHS+=("$line")
done < "$ALLOWLIST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "regen-patches: allowlist is empty" >&2
  exit 2
fi

git diff --no-color --binary "$UPSTREAM_REF"...HEAD -- ${PATHS[@]+"${PATHS[@]}"} > "$TMP/upstream-touch.patch"
if [[ ! -s "$TMP/upstream-touch.patch" ]]; then
  echo "regen-patches: no upstream-file changes in range $UPSTREAM_REF...HEAD" >&2
  exit 1
fi

case "$MODE" in
  --write)
    mkdir -p "$OUT"
    cp "$TMP/upstream-touch.patch" "$OUT/upstream-touch.patch"
    echo "regen-patches: wrote $OUT/upstream-touch.patch ($(wc -l < "$OUT/upstream-touch.patch") lines)"
    ;;
  --check)
    if [[ ! -f "$OUT/upstream-touch.patch" ]]; then
      echo "regen-patches: patches/upstream-touch.patch missing; run: bash scripts/custom/regen-patches.sh --write" >&2
      exit 1
    fi
    if ! diff -u "$OUT/upstream-touch.patch" "$TMP/upstream-touch.patch" >/dev/null; then
      echo "regen-patches: snapshot is stale; run: bash scripts/custom/regen-patches.sh --write" >&2
      diff -u "$OUT/upstream-touch.patch" "$TMP/upstream-touch.patch" | head -40 >&2 || true
      exit 1
    fi
    echo "regen-patches: snapshot is up to date"
    ;;
  *)
    echo "regen-patches: unknown mode $MODE" >&2
    exit 2
    ;;
esac

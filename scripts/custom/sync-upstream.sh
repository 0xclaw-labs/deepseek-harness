#!/usr/bin/env bash
# Merge upstream into custom/main through a reviewable branch (runs locally and
# in .github/workflows/sync-upstream.yml).
#
# Contract: custom/main only ever *merges* upstream/master; we never rebase a
# published custom branch. Conflicts can only appear in allowlisted upstream
# files (enforced by check-guards.sh), so resolution is bounded and repeatable.
#
# Env:
#   UPSTREAM_REMOTE  default "upstream"
#   UPSTREAM_BRANCH  default "master"
#   CUSTOM_BRANCH    default "custom/main"
#   SYNC_BRANCH      default "sync/upstream-$(date -u +%Y%m%d)"
#   DRY_RUN=1        fetch/compare/merge in a detached copy but never push
#   OPEN_PR=1        create a PR with gh when GH_TOKEN is set (CI default)
#
# Exit codes: 0 = nothing to do or PR opened; 1 = guard failure; 2 = merge conflict.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
CUSTOM_BRANCH="${CUSTOM_BRANCH:-custom/main}"
UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
export UPSTREAM_REF
SYNC_BRANCH="${SYNC_BRANCH:-sync/upstream-$(date -u +%Y%m%d)}"

echo "sync-upstream: fetching ${UPSTREAM_REMOTE} (${UPSTREAM_REF})"
git fetch "$UPSTREAM_REMOTE" --tags --prune

if [[ -n "$(git status --porcelain)" ]]; then
  echo "sync-upstream: working tree is not clean; commit/stash first" >&2
  exit 1
fi

if [[ -z "$(git rev-parse --verify -q "$UPSTREAM_REF")" ]]; then
  echo "sync-upstream: unknown upstream ref $UPSTREAM_REF" >&2
  exit 1
fi

git switch "$CUSTOM_BRANCH"
if git rev-parse --verify -q "origin/$CUSTOM_BRANCH" >/dev/null; then
  git pull --ff-only origin "$CUSTOM_BRANCH" >/dev/null || {
    echo "sync-upstream: local $CUSTOM_BRANCH diverged from origin; refusing to rewrite history" >&2
    exit 1
  }
fi

AHEAD="$(git rev-list --count "$CUSTOM_BRANCH..$UPSTREAM_REF")"
if [[ "$AHEAD" -eq 0 ]]; then
  echo "sync-upstream: already up to date with $UPSTREAM_REF"
  exit 0
fi
UPSTREAM_HEAD="$(git rev-parse --short "$UPSTREAM_REF")"
echo "sync-upstream: $AHEAD new upstream commit(s); head ${UPSTREAM_HEAD}"

git switch -c "$SYNC_BRANCH"
if ! git merge --no-ff "$UPSTREAM_REF" -m "chore(sync): merge upstream ${UPSTREAM_HEAD} into ${CUSTOM_BRANCH}"; then
  echo "sync-upstream: CONFLICT while merging ${UPSTREAM_REF}" >&2
  git diff --name-only --diff-filter=U | sed 's/^/  conflicted: /' >&2
  echo "sync-upstream: resolve conflicts (allowlisted files only, see UPSTREAM.md), then rerun guards and push ${SYNC_BRANCH}" >&2
  exit 2
fi

bash "$ROOT/scripts/custom/check-guards.sh"
node "$ROOT/custom/branding/apply-brand.mjs" --root "$ROOT" --check >/dev/null
echo "sync-upstream: merge clean; guards PASS"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "sync-upstream: DRY_RUN=1, not pushing ${SYNC_BRANCH}"
  exit 0
fi

git push -u origin "$SYNC_BRANCH"

if [[ "${OPEN_PR:-1}" == "1" ]] && command -v gh >/dev/null 2>&1 && [[ -n "${GH_TOKEN:-}" ]]; then
  BODY="$(mktemp)"
  {
    echo "Automated upstream merge for \`${CUSTOM_BRANCH}\`."
    echo
    echo "- Upstream: \`${UPSTREAM_REF}\` @ \`${UPSTREAM_HEAD}\`"
    echo "- New upstream commits: ${AHEAD}"
    echo "- Guards: PASS (\`scripts/custom/check-guards.sh\`)"
    echo
    echo "Upstream files changed by this merge (review list):"
    echo '```'
    git diff --name-only "$CUSTOM_BRANCH..$SYNC_BRANCH" -- . ':(exclude)custom' ':(exclude)scripts/custom' ':(exclude).github' | head -100
    echo '```'
    echo
    echo "Merge policy: see [UPSTREAM.md](../blob/${CUSTOM_BRANCH}/UPSTREAM.md). Never rebase \`${CUSTOM_BRANCH}\`."
  } > "$BODY"
  gh pr create --base "$CUSTOM_BRANCH" --head "$SYNC_BRANCH" \
    --title "chore(sync): upstream ${UPSTREAM_HEAD}" \
    --body-file "$BODY" || echo "sync-upstream: PR not created (already exists?)"
  rm -f "$BODY"
fi

echo "sync-upstream: pushed ${SYNC_BRANCH}; open PR against ${CUSTOM_BRANCH}"

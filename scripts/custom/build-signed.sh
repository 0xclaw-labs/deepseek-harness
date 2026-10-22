#!/usr/bin/env bash
# Build a branded, SIGNED + NOTARIZED desktop artifact from this fork.
#
# Usage: scripts/custom/build-signed.sh [mac-arm64|win-x64]
#
# Required env:
#   DSH_DESKTOP_UPDATE_ORIGIN   PaiNuo HTTPS feed origin (never a DeepSeek host)
#   DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN  PaiNuo mandatory-update origin
#   mac: CSC_LINK + CSC_KEY_PASSWORD (or a keychain identity) and notarization:
#        APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
#        (or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)
#   win: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (optional for now)
#
# This script exists so the signed path is explicit and fail-closed. It does not
# enable auto-update on unsigned builds and refuses upstream DeepSeek origins.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-mac-arm64}"

fail() { echo "build-signed: $*" >&2; exit 2; }

[[ -n "${DSH_DESKTOP_UPDATE_ORIGIN:-}" ]] || fail "DSH_DESKTOP_UPDATE_ORIGIN is required (PaiNuo feed origin)"
[[ -n "${DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN:-}" ]] || fail "DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN is required"
case "$DSH_DESKTOP_UPDATE_ORIGIN" in
  *deepseek.com*|*deepseeksvc.com*) fail "update origin must not be an upstream DeepSeek service" ;;
  https://*) : ;;
  *) fail "update origin must be an absolute HTTPS origin" ;;
esac

case "$TARGET" in
  mac-arm64)
    UPSTREAM_TARGET="package:desktop:mac:arm64"
    [[ -n "${CSC_LINK:-}" || -n "${CSC_NAME:-}" ]] || fail "mac signing requires CSC_LINK (+CSC_KEY_PASSWORD) or a keychain identity"
    [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]] \
      || { [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] \
        || fail "notarization requires APPLE_API_KEY/ID/ISSUER or APPLE_ID/APP_SPECIFIC_PASSWORD/TEAM_ID"; }
    ;;
  win-x64)
    UPSTREAM_TARGET="package:desktop:win:x64"
    [[ -n "${WIN_CSC_LINK:-}" && -n "${WIN_CSC_KEY_PASSWORD:-}" ]] || fail "Windows signing requires WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD"
    ;;
  *) fail "unknown target '$TARGET' (mac-arm64|win-x64)" ;;
esac

BRAND_DIR="$ROOT/custom/branding"
WORK="${WORK:-$(mktemp -d -t dsh-brand-signed-XXXXXX)}"
for path in "$WORK" "$ROOT"; do :; done
if [[ ! -e "$WORK/.git" ]]; then
  git -C "$ROOT" worktree add --detach "$WORK" custom/main
fi
node "$ROOT/custom/branding/apply-brand.mjs" --root "$WORK" --brand "$BRAND_DIR/brand.json" --replacements "$BRAND_DIR/replacements.json" --write
node "$ROOT/custom/branding/patch-cli.mjs" --root "$WORK" --brand "$BRAND_DIR/brand.json" --write
node "$ROOT/scripts/custom/verify-brand-defaults.mjs"

cd "$WORK"
[[ "${SKIP_INSTALL:-0}" == 1 ]] || pnpm install --frozen-lockfile
DSH_CLIENT_TITLE="$(node -p 'require(process.argv[1]).productName' "$BRAND_DIR/brand.json")" pnpm run build

DSH_DESKTOP_APP_ID="$(node -p 'require(process.argv[1]).appId' "$BRAND_DIR/brand.json")" \
DSH_DESKTOP_BRAND_APP_ID="$(node -p 'require(process.argv[1]).appId' "$BRAND_DIR/brand.json")" \
DSH_DESKTOP_PRODUCT_NAME="$(node -p 'require(process.argv[1]).productName' "$BRAND_DIR/brand.json")" \
DSH_DESKTOP_PROTOCOL_SCHEME="$(node -p 'require(process.argv[1]).protocolScheme' "$BRAND_DIR/brand.json")" \
DSH_DESKTOP_ARTIFACT_PREFIX="$(node -p 'require(process.argv[1]).artifactPrefix' "$BRAND_DIR/brand.json")" \
DSH_DESKTOP_BRAND_RESOURCES_DIR="$BRAND_DIR/assets" \
DSH_DESKTOP_AUTO_UPDATE_ENV=production \
DSH_DESKTOP_UPDATE_ORIGIN="$DSH_DESKTOP_UPDATE_ORIGIN" \
DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN="$DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN" \
pnpm run "$UPSTREAM_TARGET"

node "$ROOT/scripts/custom/verify-brand-manifest.mjs" "$WORK"
echo "build-signed: signed/notarized build complete (verify feed separately before publishing)."

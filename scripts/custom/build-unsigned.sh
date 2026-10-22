#!/usr/bin/env bash
# Build a branded, UNSIGNED desktop artifact from this fork in a throwaway
# worktree. Signing/notarization is intentionally skipped per product decision
# (2026-10-21); do not represent the output as signed.
#
# Usage: scripts/custom/build-unsigned.sh [mac-arm64|mac-x64|win-x64]
# Env:   WORK=/tmp/...   reuse a worktree path   KEEP=1 keep worktree after build
#        SKIP_INSTALL=1 skip pnpm install (cached node_modules)
#
# What happens:
#   1. git worktree add --detach WORK custom/main   (upstream files pristine)
#   2. apply-brand.mjs --write                       (copy/UI transform, build tree only)
#   3. pnpm install --frozen-lockfile
#   4. pnpm run build                                (upstream build)
#   5. DSH_DESKTOP_UNSIGNED=1 + brand env + package:desktop:<target>:unsigned
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Upstream requires Node "^22.19.0 || >=24.0.0" (import.meta.main and TypeScript
# type stripping). Prefer a Homebrew node when the default `node` is too old so
# scripts/build.ts actually runs instead of exiting 0 as a no-op.
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'Number(process.versions.node.split(".")[1])' 2>/dev/null || echo 0)"
if { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -lt 19 ]]; } || [[ "$NODE_MAJOR" -lt 22 ]]; then
  if [[ -x /opt/homebrew/bin/node ]]; then
    export PATH="/opt/homebrew/bin:$PATH"
    echo "build-unsigned: default node is too old for upstream; using $(node --version) from /opt/homebrew/bin"
  else
    echo "build-unsigned: node >=22.19 required by upstream; aborting (install a newer node)" >&2
    exit 2
  fi
fi

# Electron binaries are otherwise fetched from GitHub; the npmmirror is much
# faster on this network. Override ELECTRON_MIRROR to use another mirror.
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
BRAND_DIR="$ROOT/custom/branding"
TARGET="${1:-mac-arm64}"

case "$TARGET" in
  mac-arm64) UPSTREAM_TARGET="package:desktop:mac:arm64:unsigned" ;;
  mac-x64)   UPSTREAM_TARGET="package:desktop:mac:x64:unsigned" ;;
  win-x64)   UPSTREAM_TARGET="package:desktop:win:x64:unsigned" ;;
  *) echo "build-unsigned: unknown target '$TARGET' (mac-arm64|mac-x64|win-x64)" >&2; exit 2 ;;
esac

BRAND_JSON="$(node -e 'const fs=require("node:fs");const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(b))' "$BRAND_DIR/brand.json")"
read -r PRODUCT_NAME APP_ID SCHEME ARTIFACT_PREFIX < <(node -e '
const b = JSON.parse(process.argv[1]);
process.stdout.write([b.productName, b.appId, b.protocolScheme, b.artifactPrefix].join("\t") + "\n");
' "$BRAND_JSON")
for value in "$PRODUCT_NAME" "$APP_ID" "$SCHEME" "$ARTIFACT_PREFIX"; do
  if [[ -z "$value" ]]; then
    echo "build-unsigned: brand.json is missing productName/appId/protocolScheme/artifactPrefix" >&2
    exit 2
  fi
done

WORK="${WORK:-$(mktemp -d -t dsh-brand-build-XXXXXX)}"
if [[ ! -d "$WORK/.git" && ! -f "$WORK/.git" ]]; then
  git -C "$ROOT" worktree add --detach "$WORK" custom/main
fi

echo "build-unsigned: worktree $WORK"
node "$ROOT/custom/branding/apply-brand.mjs" \
  --root "$WORK" \
  --brand "$BRAND_DIR/brand.json" \
  --replacements "$BRAND_DIR/replacements.json" \
  --write

# The upstream terminal launchers name the upstream executable and leave
# DSH_HOME unset; brand them before the runtime is packaged.
node "$ROOT/custom/branding/patch-cli.mjs" \
  --root "$WORK" \
  --brand "$BRAND_DIR/brand.json" \
  --write

if ! command -v pnpm >/dev/null 2>&1; then
  echo "build-unsigned: pnpm not found; enable corepack (upstream packageManager: pnpm@11.28.5)" >&2
  exit 2
fi

cd "$WORK"
if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  pnpm install --frozen-lockfile
fi
pnpm run build

DSH_DESKTOP_UNSIGNED=1 \
DSH_DESKTOP_APP_ID="$APP_ID" \
DSH_DESKTOP_BRAND_APP_ID="$APP_ID" \
DSH_DESKTOP_PRODUCT_NAME="$PRODUCT_NAME" \
DSH_DESKTOP_PROTOCOL_SCHEME="$SCHEME" \
DSH_DESKTOP_ARTIFACT_PREFIX="$ARTIFACT_PREFIX" \
DSH_DESKTOP_BRAND_RESOURCES_DIR="$BRAND_DIR/assets" \
pnpm run "$UPSTREAM_TARGET"

# Fail loud if the packaged identity silently fell back to upstream: that build
# would share Chromium userData and the dsh:// handler with an installed
# DeepSeek Harness, and its Host would read the user's ~/.dsh.
node "$ROOT/scripts/custom/verify-brand-manifest.mjs" "$WORK"

echo "build-unsigned: done (unsigned). Find artifacts under apps/desktop (see electron-builder output above)."
if [[ "${KEEP:-0}" != "1" ]]; then
  echo "build-unsigned: leaving worktree for inspection: $WORK (remove with: git worktree remove --force \"$WORK\")"
fi

#!/usr/bin/env bash
# Thin launcher for migrate-brand-profile.mjs.
#
# Node is not a system dependency on macOS. Prefer an installed Node >= 18;
# otherwise run the engine through the installed 随身搭子 Electron binary with
# ELECTRON_RUN_AS_NODE, which is present wherever the app is installed.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$SCRIPT_DIR/migrate-brand-profile.mjs"
APP="${DSH_MIGRATION_BRAND_APP:-/Applications/随身搭子.app}"

if [[ ! -f "$ENGINE" ]]; then
  echo "migrate-brand-profile: engine not found: $ENGINE" >&2
  exit 2
fi

node_ok() {
  local candidate="${1:-}"
  [[ -n "$candidate" && -x "$candidate" ]] || return 1
  "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

NODE_BIN="${DSH_MIGRATION_NODE:-}"
if ! node_ok "$NODE_BIN"; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if ! node_ok "$NODE_BIN"; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if node_ok "$candidate"; then NODE_BIN="$candidate"; break; fi
  done
fi
if node_ok "$NODE_BIN"; then
  exec "$NODE_BIN" "$ENGINE" "$@"
fi

# Electron-as-Node fallback. The executable is named after the .app bundle.
APP_BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
if [[ -x "$APP_BIN" ]]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$APP_BIN" "$ENGINE" "$@"
fi

echo "migrate-brand-profile: no Node >= 18 found and no Electron runtime at $APP_BIN" >&2
echo "  set DSH_MIGRATION_NODE=/path/to/node or DSH_MIGRATION_BRAND_APP=/path/to/随身搭子.app" >&2
exit 2

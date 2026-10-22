
## Icon geometry (2026-10-21)
- `icon-macos.png`: 1024×1024 RGBA, 824×824 content area centered (100px transparent
  margin), superellipse (squircle, exponent 5) mask with 4× supersampled edges.
  macOS does not round third-party icons automatically — a full-bleed square PNG
  shows hard 90° corners in Dock/Finder.
- `icon-windows.png`: 1024×1024 RGBA, rounded-square tile (radius 160) with
  transparent corners for Windows 11 taskbar/tile surfaces.
- The build converts the macOS PNG into a complete iconset/icns; do not replace it
  with the raw square artwork.

## Copy rules (2026-10-22)
`apply-brand.mjs` substitutes exact strings from `replacements.json`; each rule is
`{ from, to }`, plus `skipWhenPrecededBy` when `to` still contains `from`. That
guard keeps a prefix rule (`DeepSeek-V4.1-Flash` → `派诺·DeepSeek-V4.1-Flash`)
idempotent, so re-running `--write` on an already-branded worktree cannot double
the prefix. Rules whose `to` is not the product name print their own target in
the report. `--check` runs on the pristine checkout (CI guard, post-merge sync)
and fails when a rule's `from` no longer exists anywhere, naming the stale string:
upstream copy drift must be visible instead of silently un-branded. Model display
names that arrive as wire ids are minted at runtime instead
(`apps/desktop/src/model-display.ts`), because the proxy catalog is dynamic.
`apply-brand.test.mjs` covers both, the untouched wire ids, and rule-drift failure.

## Terminal launcher (2026-10-22)
`patch-cli.mjs` runs on the build worktree after `apply-brand.mjs`. Upstream's
`apps/desktop/cli/dsh` and `dsh.cmd` hardcode the upstream executable name and
leave `DSH_HOME` unset; the transform names the branded executable and pins
`DSH_HOME`/`DSH_AGENTS_HOME` to the bundle's private profile directory, so the
installed `dsh` command never falls back to `~/.dsh`. `verify-brand-manifest.mjs`
checks the packaged launch scripts, and `patch-cli.test.mjs` covers both
launchers and idempotence.

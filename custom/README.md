# custom/ — fork-specific surface (0xclaw-labs/deepseek-harness)

Everything in this directory is ours, not upstream. It is designed so upstream
can be merged into `custom/main` on a schedule without re-resolving the same
conflicts and without touching upstream UI files for branding.

- `branding/brand.json` – product identity used by the build (name, app id,
  protocol scheme, artifact prefix, icon inputs).
- `branding/replacements.json` – exact UI-copy replacements applied to a build
  worktree only (currently upstream display name → 随身搭子).
- `branding/apply-brand.mjs` – deterministic transformer; `--check` in CI,
  `--write` in a throwaway worktree before packaging.
- `branding/assets/` – icon inputs copied over upstream asset paths at build time.
- `upstream-touch-allowlist.txt` – the only upstream files our patch stack may
  modify. `scripts/custom/check-guards.sh` enforces it.

Feature work that must alter upstream files goes into a separate small commit
and the allowlist; preferential order is always:

1. new files/directories under `custom/` or a new package,
2. build-time configuration (env vars, transform data),
3. a minimal patch to an allowlisted upstream file (with a regenerated
   `patches/` snapshot).

Policy, branch model and the upgrade procedure are documented in `../UPSTREAM.md`.

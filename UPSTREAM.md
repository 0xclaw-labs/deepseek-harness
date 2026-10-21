# Upstream relationship and sync policy (fork: 0xclaw-labs/deepseek-harness)

This repository is a fork of [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
Upstream history, license and third-party notices are kept intact. Our product
changes live **only** on the `custom/main` branch, and we keep them small enough
that upstream upgrades stay routine.

## Branches

| Branch | Meaning | Who writes it |
| --- | --- | --- |
| `master` | Byte-for-byte mirror of `upstream/master` (fast-forward only) | bot / `git push origin upstream/master:master` |
| `custom/main` | Default branch of this fork: upstream + our customization commits | humans, via PR |
| `sync/upstream-*` | Temporary branch produced by `scripts/custom/sync-upstream.sh`: `custom/main` + upstream merge | automation (PR) |

Never push custom commits to `master`. Never rebase `custom/main` onto upstream
after it has been published: upgrades are **merges** (`git merge upstream/master`),
so already-resolved conflicts never have to be resolved again and `git log`
keeps the upstream ancestry reviewers and tooling expect.

## How customization is organised (why upgrades stay cheap)

1. **Deployment identity is configuration, not code.** Desktop product name,
   app id, protocol scheme, artifact prefix and brand asset directory are read
   from environment variables by the one patched packaging file
   (`apps/desktop/scripts/electron-builder-config.mjs`). A branded build supplies
   `DSH_DESKTOP_PRODUCT_NAME`, `DSH_DESKTOP_APP_ID`, `DSH_DESKTOP_PROTOCOL_SCHEME`,
   `DSH_DESKTOP_ARTIFACT_PREFIX`, `DSH_DESKTOP_BRAND_RESOURCES_DIR`; upstream
   defaults are unchanged, so the patch is upstreamable and tiny.
2. **Bulk UI copy and icon swaps are a build-time transform, not commits.**
   `custom/branding/apply-brand.mjs` walks the checkout before the build and
   replaces the exact product strings listed in
   `custom/branding/replacements.json`, then copies icons from
   `custom/branding/assets/`. Upstream files are never edited in git for this,
   so a rename/reword upstream does not create a merge conflict (the transform
   simply stops matching and the guard reports it).
3. **Features live in new directories**, not as edits to upstream files. Anything
   that must touch upstream code is kept as a separate small commit, listed in
   `custom/upstream-touch-allowlist.txt`, and exported to `patches/` for review
   and as a fallback if a future merge conflicts.

## Upgrading upstream

Local (interactive, recommended for big jumps):

```bash
git fetch upstream --tags
git switch custom/main
git merge --no-ff upstream/master        # resolve conflicts only in allowlisted files
bash scripts/custom/check-guards.sh       # fails if we touched non-allowlisted upstream files
node custom/branding/apply-brand.mjs --root . --check
bash scripts/custom/build-unsigned.sh mac-arm64   # optional: prove the branded build still works
git push origin custom/main
```

Automated (daily, see `.github/workflows/sync-upstream.yml`): the workflow runs
`scripts/custom/sync-upstream.sh`, which merges `upstream/master` into a
`sync/upstream-YYYYMMDD` branch. A clean merge opens a pull request with the
upstream range, changed upstream files and guard output. Conflicts are reported
in a GitHub issue with the conflicted file list and the PR attempt; a human
resolves them (conflicts can only occur in allowlisted files, by construction).

## Rules (enforced by `scripts/custom/check-guards.sh`)

- Only files listed in `custom/upstream-touch-allowlist.txt` may differ from
  `upstream/master`; everything else must be new files under `custom/`,
  `scripts/custom/`, `.github/workflows/` or `patches/`.
- Any change to the allowlist needs a matching commit message and a regenerated
  `patches/` snapshot (`scripts/custom/regen-patches.sh --write`).
- Branding assets/copy are data (`custom/branding/*.json`), never hardcoded in
  upstream sources.

## Signing

Per product decision (2026-10-21) we ship **unsigned** desktop artifacts for
now: `DSH_DESKTOP_UNSIGNED=1` uses upstream's unsigned packaging targets
(`package:desktop:mac:arm64:unsigned`, `mac:x64:unsigned`, `win:x64:unsigned`).
Signing/notarization remains NOT_VERIFIED until certificates exist; do not
claim otherwise in release notes.

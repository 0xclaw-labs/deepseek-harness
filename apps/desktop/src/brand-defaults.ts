/**
 * Brand-owned defaults for a freshly initialized Desktop profile.
 *
 * The bundled bundles still describe the upstream deployment: their model
 * route is the public DeepSeek API, their web search route is DeepSeek's
 * search API, and their desktop telemetry exporter targets the upstream
 * collector. A rebranded package must not inherit those deployment choices on
 * first use. This module writes one reviewed block into the user's profile
 * patch, which the Host applies after every bundle layer. Later user rows keep
 * winning, so a saved model or search selection is never overwritten.
 *
 * The block is delimited by its own comments because it contains several
 * rows; the previous generated blocks targeted one row and could be removed by
 * counting `- id:` lines. `brand-defaults` is a generated marker, not user
 * content.
 *
 * @module @deepseek-ai/dsh-desktop/brand-defaults
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** The branded first-use Workspace row, kept separate because it is regenerated on every move. */
export function brandWorkspaceBlock(workspacePath: string): string {
  return '# brand-default-workspace: the branded first-use Workspace, never upstream\'s Documents/deepseek-harness.\n'
    + '- id: workspace-controller\n'
    + '  config:\n'
    + `    defaultWorkspacePath: ${JSON.stringify(workspacePath)}\n`
}

/** First line of the generated block; also the removal anchor. */
export const BRAND_DEFAULTS_BEGIN = '# brand-defaults: begin'

/** Last line of the generated block. */
export const BRAND_DEFAULTS_END = '# brand-defaults: end'

/**
 * The complete generated block. The provider id is the branded `painuo` route registered by the desktop
 * catalog bootstrap; model ids stay the upstream-visible namespace. Web search is left unselected so a fresh install never
 * calls the upstream search endpoint before the user configures a provider.
 * Telemetry and product analytics are off because this deployment has no
 * branded collector; enabling them would send events to the upstream
 * collector named by the bundle's default endpoint.
 * @returns the block, newline-terminated.
 */
export function brandDefaultsBlock(): string {
  return [
    `${BRAND_DEFAULTS_BEGIN} - PaiNuo deployment defaults; later user rows win.`,
    '# Route sessions through the branded account (auth.modelxing.com), not the public DeepSeek API.',
    '- id: agent-default-model',
    '  config:',
    '    provider: painuo',
    '    model: deepseek-v4.1-flash-1017-local',
    '# Leave search unselected; a fresh install must not call an upstream search endpoint.',
    '- id: web',
    '  config:',
    '    fetchProvider: http',
    '# This deployment has no branded collector; never send events to the upstream one.',
    '- id: desktop-product-telemetry',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
    `${BRAND_DEFAULTS_END}`,
    '',
  ].join('\n')
}

/**
 * Remove one previously generated block without touching user rows.
 * @param existing - Current profile patch text.
 * @returns Text with the generated block removed, or the input when a begin
 *   marker has no end marker (a hand-edited/corrupt block is left alone so a
 *   rewrite cannot swallow the rows after it).
 */
export function stripBrandDefaults(existing: string): string {
  const begin = existing.indexOf(BRAND_DEFAULTS_BEGIN)
  if (begin === -1) return existing
  const end = existing.indexOf(BRAND_DEFAULTS_END, begin)
  if (end === -1) return existing
  const afterEnd = existing.slice(end + BRAND_DEFAULTS_END.length)
  return existing.slice(0, begin) + afterEnd.replace(/^\r?\n/u, '')
}

/**
 * Compose the profile patch with exactly one generated defaults block at the
 * front, preserving user rows and removing the `[]` placeholder an empty
 * upstream profile ships with. The block is prepended so every later row,
 * including a user-edited model or search choice, overrides it.
 * @param existing - Current profile patch text (empty when the file is absent).
 * @returns The next patch text; identical to `existing` when an unterminated
 *   generated block is present.
 */
export function composeBrandDefaults(existing: string): string {
  const begin = existing.indexOf(BRAND_DEFAULTS_BEGIN)
  if (begin !== -1 && existing.indexOf(BRAND_DEFAULTS_END, begin) === -1) return existing
  const rest = stripBrandDefaults(existing)
    .split('\n')
    .filter(line => line.trim() !== '[]')
    .join('\n')
    .trim()
  const block = brandDefaultsBlock()
  return rest === '' ? block : `${block}${rest}\n`
}

/**
 * Create or update the generated defaults block in a profile patch.
 * @param patchPath - Absolute profile `cordis.patch.yml` path.
 * @returns Whether the file changed.
 */
export function applyBrandDefaults(patchPath: string): boolean {
  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const next = composeBrandDefaults(existing)
  if (next === existing) return false
  writeFileSync(patchPath, next, { mode: 0o600 })
  return true
}

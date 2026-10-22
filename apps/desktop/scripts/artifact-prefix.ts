/** Brand artifact prefix shared by packaging, upload and retention. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Brand manifest fallback when the packaging environment does not name a prefix. */
function manifestPrefix(): string {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../custom/branding/brand.json', import.meta.url)), 'utf8')) as { artifactPrefix?: unknown }
    if (typeof manifest.artifactPrefix === 'string' && manifest.artifactPrefix.trim() !== '') return manifest.artifactPrefix.trim()
  } catch {
    // The branded build always ships the manifest; a source checkout without it
    // still needs a deterministic prefix rather than the upstream one.
  }
  return 'suishendazi-harness'
}

/**
 * Resolve the artifact filename prefix used by every signed/unsigned package.
 * @param env - packaging environment; `DSH_DESKTOP_ARTIFACT_PREFIX` overrides the manifest.
 * @returns a lowercase prefix without path separators.
 */
export function resolveArtifactPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_DESKTOP_ARTIFACT_PREFIX?.trim()
  const prefix = configured === undefined || configured === '' ? manifestPrefix() : configured
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(prefix)) throw new Error(`desktop artifact prefix is invalid: ${JSON.stringify(prefix)}`)
  return prefix
}

/** Escape one literal for use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

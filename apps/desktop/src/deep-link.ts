/** Deep-link classification for the Electron shell. */

/** Upstream DeepSeek Harness scheme. Read for compatibility; never registered by a rebrand. */
export const LEGACY_DEEP_LINK_SCHEME = 'dsh'

/** A deep link action the shell knows how to perform. */
export type DeepLinkAction = 'focus-primary-window'

/**
 * Validate a protocol scheme supplied by the package manifest or environment.
 * @param value - untrusted manifest or environment value.
 * @param fallback - scheme used when the value is absent or malformed.
 * @returns a lower-case RFC 3986 scheme, or the fallback.
 */
export function resolveDeepLinkScheme(value: unknown, fallback = LEGACY_DEEP_LINK_SCHEME): string {
  if (typeof value !== 'string') return fallback
  const scheme = value.trim().toLowerCase()
  return /^[a-z][a-z0-9+.-]*$/u.test(scheme) ? scheme : fallback
}

/**
 * Classify a macOS `open-url` payload.
 *
 * The packaged bundle declares exactly one scheme (`CFBundleURLTypes`). A
 * rebranded bundle registers that scheme and keeps reading upstream
 * `dsh://open` for links LaunchServices still delivers to it, without ever
 * claiming `dsh://` as default. URLs on the primary scheme focus the app —
 * including a future OAuth callback path; the current sign-in flow uses a
 * loopback HTTP callback instead. Legacy URLs are limited to upstream's
 * `/open` route so unrelated `dsh://` links do not activate the app.
 *
 * @param raw - URL received from the operating system.
 * @param primaryScheme - scheme declared by this bundle.
 * @returns the action to perform, or undefined for an unrelated URL.
 */
export function parseDeepLink(raw: string, primaryScheme: string): DeepLinkAction | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  const primary = resolveDeepLinkScheme(primaryScheme)
  if (scheme !== primary && scheme !== LEGACY_DEEP_LINK_SCHEME) return undefined
  // A rebrand may receive any path on its own scheme (including a future OAuth callback).
  if (scheme === primary && scheme !== LEGACY_DEEP_LINK_SCHEME) return 'focus-primary-window'
  // Custom-scheme URLs put the first segment in the host (`dsh://open` has host `open`).
  const target = `${url.hostname}${url.pathname}`.replace(/\/+$/u, '')
  return target === 'open' || target === '' ? 'focus-primary-window' : undefined
}

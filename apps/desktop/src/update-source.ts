/**
 * Packaged auto-update source policy for the branded Desktop.
 *
 * A branded build ships either with a PaiNuo-operated generic feed or with no
 * feed at all; it never polls an upstream DeepSeek destination. The packaging
 * path already refuses to build a production release without an explicit
 * `DSH_DESKTOP_UPDATE_ORIGIN` (`desktop-auto-update-environment.mjs`), and this
 * module re-validates the feed sealed into the installed application before the
 * updater is allowed to make a request. A build without a feed is a supported
 * deployment, not a failure: the shell reports "no automatic updates" instead
 * of a fake check failure, and the coordinator performs no network work.
 *
 * The sealed file is electron-updater's `app-update.yml`, written by
 * electron-builder (Windows) or `macos-app-update-config.mjs` (macOS) before
 * code signing. Only the `generic` provider is accepted; a GitHub or COS
 * publisher row would resolve to a different transport than the reviewed one.
 *
 * @module @deepseek-ai/dsh-desktop/update-source
 */

import { readFileSync } from 'node:fs'
import { isUpstreamDeepSeekHost } from './brand-endpoints.ts'

/** Installer-owned update channel; mirrors the packaged manifest channel. */
export type DesktopUpdateSourceChannel = 'nightly' | 'latest'

/**
 * Why a sealed feed is unusable. The shell shows localized copy for the kind;
 * the reason stays in logs and diagnostics.
 */
export type DesktopUpdateSourceRejection =
  | 'config-unreadable'
  | 'config-malformed'
  | 'provider-unsupported'
  | 'url-malformed'
  | 'url-insecure'
  | 'upstream-host'
  | 'channel-mismatch'

/** A validated PaiNuo-operated generic feed the updater may poll. */
export interface DesktopUpdateSourceConfigured {
  readonly kind: 'configured'
  readonly url: string
  readonly channel: DesktopUpdateSourceChannel
}

/** A build that ships no update feed; automatic updates are unsupported. */
export interface DesktopUpdateSourceAbsent {
  readonly kind: 'absent'
}

/** A sealed feed that failed validation; the updater must not use it. */
export interface DesktopUpdateSourceRejected {
  readonly kind: 'rejected'
  readonly reason: DesktopUpdateSourceRejection
}

/** Validated deployment of the packaged updater. */
export type DesktopUpdateSource =
  | DesktopUpdateSourceConfigured
  | DesktopUpdateSourceAbsent
  | DesktopUpdateSourceRejected

/** Inputs for one source resolution; the reader is injectable for tests. */
export interface DesktopUpdateSourceOptions {
  /** Whether this process runs from an installed application bundle. */
  readonly packaged: boolean
  /** Absolute path of the sealed `app-update.yml`. */
  readonly configPath: string
  /** Channel sealed into the installed application manifest. */
  readonly expectedChannel: DesktopUpdateSourceChannel
  /** Returns the file contents, or undefined when the file does not exist. */
  readonly readConfig?: (path: string) => string | undefined
}

/** Fields read from one sealed updater configuration. */
interface SealedUpdateConfig {
  readonly provider?: string
  readonly url?: string
  readonly channel?: string
}

/**
 * Read one sealed configuration, tolerating only an absent file.
 * @param path - Absolute path of `app-update.yml`.
 * @returns File contents, or undefined when the file does not exist.
 * @throws when the file exists but cannot be read.
 */
function readSealedConfig(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    // A missing file is the normal state of an unsigned/dev build; any other
    // failure must reach the caller instead of looking like "no feed".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read the three scalar fields this policy validates from electron-updater's
 * configuration. Other keys (`updaterCacheDirName`, publisher rows) are
 * ignored: the updater still reads them, while only these select a destination.
 * @param text - Sealed configuration text.
 * @returns Trimmed field values, or undefined when a field repeats.
 */
function parseSealedConfig(text: string): SealedUpdateConfig | undefined {
  const fields: Record<keyof SealedUpdateConfig, string | undefined> = {
    provider: undefined, url: undefined, channel: undefined,
  }
  const seen = new Set<keyof SealedUpdateConfig>()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    if (key !== 'provider' && key !== 'url' && key !== 'channel') continue
    if (seen.has(key)) return undefined
    seen.add(key)
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, '$2')
    fields[key] = value === '' ? undefined : value
  }
  return fields
}

/**
 * Validate one parsed feed URL. Only an absolute HTTPS origin with a path
 * accepts updates; credentials, queries, and fragments are rejected because
 * the packaged writer never emits them and they change the request target.
 * @param value - Parsed `url` field.
 * @returns Normalized feed URL, or the rejection reason.
 */
function validateFeedUrl(value: string): { url: string } | { reason: DesktopUpdateSourceRejection } {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (_error) {
    return { reason: 'url-malformed' }
  }
  if (parsed.protocol !== 'https:') return { reason: 'url-insecure' }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    return { reason: 'url-malformed' }
  }
  if (!parsed.pathname.endsWith('/')) return { reason: 'url-malformed' }
  if (isUpstreamDeepSeekHost(parsed.hostname)) return { reason: 'upstream-host' }
  return { url: parsed.toString() }
}

/**
 * Resolve the deployment of the packaged updater. Every rejection is final for
 * this process: the coordinator never falls back to another destination,
 * because a branded build has no reviewed second feed.
 * @param options - Packaged state, sealed configuration path, and expected channel.
 * @returns Validated source, an absent source, or a typed rejection.
 */
export function resolveDesktopUpdateSource(options: DesktopUpdateSourceOptions): DesktopUpdateSource {
  if (!options.packaged) return { kind: 'absent' }
  const read = options.readConfig ?? readSealedConfig
  let text: string | undefined
  try {
    text = read(options.configPath)
  } catch (_error) {
    return { kind: 'rejected', reason: 'config-unreadable' }
  }
  if (text === undefined) return { kind: 'absent' }
  const config = parseSealedConfig(text)
  if (config === undefined) return { kind: 'rejected', reason: 'config-malformed' }
  if (config.provider !== 'generic') return { kind: 'rejected', reason: 'provider-unsupported' }
  if (config.channel !== options.expectedChannel) return { kind: 'rejected', reason: 'channel-mismatch' }
  if (config.url === undefined) return { kind: 'rejected', reason: 'config-malformed' }
  const validated = validateFeedUrl(config.url)
  return 'reason' in validated
    ? { kind: 'rejected', reason: validated.reason }
    : { kind: 'configured', url: validated.url, channel: options.expectedChannel }
}
